import "server-only";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  lt,
  max,
  or,
  sql,
} from "drizzle-orm";

import { hashPassword } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { normalizeLoginEmail } from "@/lib/login-throttle";
import {
  createResetToken,
  hashResetToken,
  PASSWORD_RESET_TTL_MS,
} from "@/lib/password-reset";
import {
  cards,
  annotations,
  blobReservations,
  generationJobs,
  loginThrottles,
  passwordResetTokens,
  reviewers,
  users,
  sources,
  testSessions,
  testAttempts,
  cardReviews,
  topics,
  views,
  type GenerationJob,
  type Card,
  type NewGenerationJob,
  type NewSource,
  type Reviewer,
  type Source,
  type Topic,
} from "@/lib/schema";
import {
  annotationRemapRows,
  annotationSaveRows,
  MAX_ACTIVE_ANNOTATIONS,
  normalizeDocumentText,
  remapAnnotation,
  renderedStudyTextModel,
  selectRenderableAnnotations,
  type AnnotationColor,
  type AnnotationRecord,
  type RemappedAnnotation,
} from "@/lib/annotations";
import type { CardRating, DurableCard, GenerationJobStep, TestAttemptStats } from "@/lib/types";
import {
  isClozeCardFront,
  isValidCardFront,
  normalizeLearningIds,
  parseCardedItems,
  parseTestMeItems,
} from "@/lib/learning";
import {
  MAX_CARDED_ITEMS,
  MAX_CARD_BACK_CHARS,
  MAX_CARD_FRONT_CHARS,
  MAX_GENERATED_JSON_CHARS,
  MAX_GENERATED_MARKDOWN_CHARS,
  MAX_LEARNING_ID_CHARS,
  MAX_TEST_ATTEMPT_ITEMS,
  MAX_TEST_ATTEMPT_SELECTED_ANSWER_CHARS,
} from "@/lib/learning-limits";
import { publicSourceErrorMessage, PublicError } from "@/lib/public-errors";
import { scheduleCardReview } from "@/lib/sm2";
import {
  missedItemIds,
  resolveUntimedAttemptReread,
  sameItemSnapshot,
  snapshotTestItemIds,
} from "@/lib/practice-session";
import {
  type GenerateKind,
} from "@/lib/generation-plan";

export async function listTopics(userId: string): Promise<Topic[]> {
  return db
    .select()
    .from(topics)
    .where(eq(topics.userId, userId))
    .orderBy(asc(topics.sortOrder), asc(topics.createdAt));
}

export async function getTopic(
  id: string,
  userId: string,
): Promise<Topic | null> {
  const [row] = await db
    .select()
    .from(topics)
    .where(and(eq(topics.id, id), eq(topics.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function createTopic(userId: string, name: string): Promise<Topic> {
  const [agg] = await db
    .select({ maxOrder: max(topics.sortOrder) })
    .from(topics)
    .where(eq(topics.userId, userId));
  const sortOrder = (agg?.maxOrder ?? -1) + 1;
  const [row] = await db
    .insert(topics)
    .values({ userId, name, sortOrder })
    .returning();
  return row;
}

export async function renameTopic(
  id: string,
  userId: string,
  name: string,
): Promise<Topic | null> {
  const [row] = await db
    .update(topics)
    .set({ name })
    .where(and(eq(topics.id, id), eq(topics.userId, userId)))
    .returning();
  return row ?? null;
}

/** Cascade deletes reviewers/sources/views via FK. */
export async function deleteTopic(
  id: string,
  userId: string,
): Promise<Topic | null> {
  const [row] = await db
    .delete(topics)
    .where(and(eq(topics.id, id), eq(topics.userId, userId)))
    .returning();
  return row ?? null;
}

/**
 * Mark a topic before any external Blob work. Source creation locks the topic
 * and checks this marker in its final insert, closing the list/delete race.
 * A stale lease is reclaimable after 15 minutes so a crashed deletion can be
 * retried while a live cleanup claim remains protected during its window.
 */
export async function beginTopicDeletion(
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE topics
    SET deleting_at = NOW()
    WHERE id = ${id}
      AND user_id = ${userId}
      AND (
        deleting_at IS NULL
        OR deleting_at < NOW() - INTERVAL '15 minutes'
      )
    RETURNING id
  `);
  return result.rows.length > 0;
}

export type ReviewerByTopic = Reviewer & { dueTodayCount: number };

/**
 * Due-today math for home pack rows. A durable card counts when it is not
 * archived and `dueAt` is at or before `now`. Deleting reviewers contribute 0.
 */
export function countDueTodayCards(
  cardRows: ReadonlyArray<{ dueAt: Date; archivedAt: Date | null }>,
  args: { now: Date; reviewerDeletingAt: Date | null },
): number {
  if (args.reviewerDeletingAt != null) return 0;
  const nowMs = args.now.getTime();
  let n = 0;
  for (const card of cardRows) {
    if (card.archivedAt != null) continue;
    if (card.dueAt.getTime() > nowMs) continue;
    n += 1;
  }
  return n;
}

export async function listReviewersByTopic(
  topicId: string,
  userId: string,
): Promise<ReviewerByTopic[]> {
  return db
    .select({
      id: reviewers.id,
      topicId: reviewers.topicId,
      name: reviewers.name,
      createdAt: reviewers.createdAt,
      lastGeneratedAt: reviewers.lastGeneratedAt,
      examDate: reviewers.examDate,
      deletingAt: reviewers.deletingAt,
      dueTodayCount: sql<number>`
        case
          when ${reviewers.deletingAt} is not null then 0
          else (
            select count(*)::int
            from cards
            where cards.reviewer_id = ${reviewers.id}
              and cards.due_at <= now()
              and cards.archived_at is null
          )
        end
      `.mapWith(Number),
    })
    .from(reviewers)
    .innerJoin(topics, eq(reviewers.topicId, topics.id))
    .where(and(eq(reviewers.topicId, topicId), eq(topics.userId, userId)))
    .orderBy(asc(reviewers.createdAt));
}

export async function getReviewer(
  id: string,
  userId: string,
): Promise<Reviewer | null> {
  const [row] = await db
    .select({
      id: reviewers.id,
      topicId: reviewers.topicId,
      name: reviewers.name,
      createdAt: reviewers.createdAt,
      lastGeneratedAt: reviewers.lastGeneratedAt,
      examDate: reviewers.examDate,
      deletingAt: reviewers.deletingAt,
    })
    .from(reviewers)
    .innerJoin(topics, eq(reviewers.topicId, topics.id))
    .where(and(eq(reviewers.id, id), eq(topics.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function createReviewer(
  topicId: string,
  userId: string,
  name: string,
): Promise<Reviewer | null> {
  const topic = await getTopic(topicId, userId);
  if (!topic) return null;
  const [row] = await db
    .insert(reviewers)
    .values({ topicId, name })
    .returning();
  return row;
}

export async function renameReviewer(
  id: string,
  userId: string,
  name: string,
): Promise<Reviewer | null> {
  const existing = await getReviewer(id, userId);
  if (!existing) return null;
  const [row] = await db
    .update(reviewers)
    .set({ name })
    .where(eq(reviewers.id, id))
    .returning();
  return row ?? null;
}

/** Cascade deletes sources/views via FK. */
export async function deleteReviewer(
  id: string,
  userId: string,
): Promise<Reviewer | null> {
  const existing = await getReviewer(id, userId);
  if (!existing) return null;
  const [row] = await db
    .delete(reviewers)
    .where(eq(reviewers.id, id))
    .returning();
  return row ?? null;
}

/** Mark a reviewer before external Blob work, atomically with ownership. */
export async function beginReviewerDeletion(
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE reviewers AS r
    SET deleting_at = NOW()
    FROM topics AS t
    WHERE r.id = ${id}
      AND r.topic_id = t.id
      AND t.user_id = ${userId}
      AND (
        r.deleting_at IS NULL
        OR r.deleting_at < NOW() - INTERVAL '15 minutes'
      )
    RETURNING r.id
  `);
  return result.rows.length > 0;
}

export async function listSourcesByReviewer(
  reviewerId: string,
  userId: string,
): Promise<Source[]> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  return db
    .select()
    .from(sources)
    .where(eq(sources.reviewerId, reviewerId))
    .orderBy(asc(sources.createdAt));
}

/** Keep a direct upload protected while the browser registers its source. */
export const BLOB_RESERVATION_LEASE_MS = 24 * 60 * 60 * 1000;

export type BlobReservationResult =
  | { outcome: "reserved"; sourceId: null; attemptToken: string }
  | { outcome: "registered"; sourceId: string; attemptToken: string | null }
  | { outcome: "busy" | "conflict"; sourceId: null; attemptToken: null };

/**
 * Atomically claim a pathname for this owner. Token minting and source POST
 * both call this function, so a delayed registration is visible to cleanup
 * before the first byte is read. A live reservation is never stolen.
 */
export async function reserveBlobForRegistration(
  userId: string,
  reviewerId: string,
  pathname: string,
  requestedAttemptToken?: string,
  leaseMs: number = BLOB_RESERVATION_LEASE_MS,
  options: { allowTokenCreation?: boolean } = {},
): Promise<BlobReservationResult> {
  // The token is generated per upload attempt and is never derived from a
  // pathname, filename, or user id. The client echoes it only in the
  // authenticated source-registration request; the database compares it as
  // an opaque CAS value.
  const attemptToken = requestedAttemptToken?.trim() || crypto.randomUUID();
  // Only the authenticated server-side mint path may create or take over a
  // reservation with a new token. Registration can renew only the exact live
  // row created for this pathname, preventing cross-path token replay.
  const allowTokenCreation = options.allowTokenCreation ?? requestedAttemptToken === undefined;
  const leaseSeconds = Math.max(60, Math.floor(leaseMs / 1000));
  const result = await db.execute(sql`
    WITH eligible_reviewer AS MATERIALIZED (
      SELECT r.id
      FROM reviewers AS r
      INNER JOIN topics AS t ON t.id = r.topic_id
      WHERE r.id = ${reviewerId}
        AND t.user_id = ${userId}
        AND r.deleting_at IS NULL
        AND t.deleting_at IS NULL
      FOR UPDATE OF r, t
    ),
    existing_source AS MATERIALIZED (
      SELECT s.id, s.reviewer_id, s.deleting_at
      FROM sources AS s
      WHERE s.blob_pathname = ${pathname}
      LIMIT 1
    ),
    claimed AS (
      INSERT INTO blob_reservations (
        user_id,
        reviewer_id,
        pathname,
        attempt_token,
        state,
        lease_expires_at,
        created_at,
        updated_at
      )
      SELECT
        ${userId},
        ${reviewerId},
        ${pathname},
        ${attemptToken},
        'reserved'::blob_reservation_state,
        NOW() + (${leaseSeconds} * INTERVAL '1 second'),
        NOW(),
        NOW()
      FROM eligible_reviewer
      WHERE NOT EXISTS (SELECT 1 FROM existing_source)
        AND (
          ${allowTokenCreation}
          OR EXISTS (
            SELECT 1
            FROM blob_reservations AS exact_token
            WHERE exact_token.pathname = ${pathname}
              AND exact_token.user_id = ${userId}
              AND exact_token.reviewer_id = ${reviewerId}
              AND exact_token.attempt_token = ${attemptToken}
              AND exact_token.state IN (
                'released'::blob_reservation_state,
                'reserved'::blob_reservation_state
              )
              AND exact_token.lease_expires_at > NOW()
          )
        )
      ON CONFLICT (pathname) DO UPDATE
      SET state = 'reserved'::blob_reservation_state,
          attempt_token = EXCLUDED.attempt_token,
          lease_expires_at = EXCLUDED.lease_expires_at,
          updated_at = NOW()
      WHERE blob_reservations.user_id = EXCLUDED.user_id
        AND blob_reservations.reviewer_id = EXCLUDED.reviewer_id
        AND (
          (
            blob_reservations.attempt_token = EXCLUDED.attempt_token
            AND blob_reservations.state IN ('released'::blob_reservation_state, 'reserved'::blob_reservation_state)
            AND (${allowTokenCreation} OR blob_reservations.lease_expires_at > NOW())
          )
          OR (
            ${allowTokenCreation}
            AND
            blob_reservations.attempt_token <> EXCLUDED.attempt_token
            AND blob_reservations.state IN ('released'::blob_reservation_state, 'reserved'::blob_reservation_state, 'deleting'::blob_reservation_state)
            AND blob_reservations.lease_expires_at <= NOW()
          )
        )
      RETURNING id, attempt_token
    ),
    current_reservation AS MATERIALIZED (
      SELECT br.user_id, br.reviewer_id, br.attempt_token, br.state, br.lease_expires_at
      FROM blob_reservations AS br
      WHERE br.pathname = ${pathname}
      LIMIT 1
    )
    SELECT
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM existing_source AS es
          INNER JOIN eligible_reviewer AS er ON er.id = es.reviewer_id
          WHERE es.deleting_at IS NULL
        ) THEN 'registered'
        WHEN EXISTS (
          SELECT 1
          FROM existing_source AS es
          INNER JOIN eligible_reviewer AS er ON er.id = es.reviewer_id
        ) THEN 'busy'
        WHEN EXISTS (SELECT 1 FROM existing_source) THEN 'conflict'
        WHEN EXISTS (SELECT 1 FROM claimed) THEN 'reserved'
        WHEN EXISTS (
          SELECT 1 FROM current_reservation AS cr
          WHERE cr.user_id = ${userId}
            AND cr.reviewer_id = ${reviewerId}
            AND cr.attempt_token = ${attemptToken}
            AND cr.state IN (
              'released'::blob_reservation_state,
              'reserved'::blob_reservation_state
            )
            AND cr.lease_expires_at > NOW()
        ) THEN 'reserved'
        ELSE 'conflict'
      END AS outcome,
      (
        SELECT es.id
        FROM existing_source AS es
        INNER JOIN eligible_reviewer AS er ON er.id = es.reviewer_id
        LIMIT 1
      ) AS source_id,
      (SELECT cr.attempt_token FROM current_reservation AS cr LIMIT 1) AS current_attempt_token,
      (SELECT c.attempt_token FROM claimed AS c LIMIT 1) AS claimed_attempt_token
  `);
  const row = result.rows[0] as
    | {
        outcome?: string;
        source_id?: string | null;
        current_attempt_token?: string | null;
        claimed_attempt_token?: string | null;
      }
    | undefined;
  if (row?.outcome === "registered" && row.source_id) {
    return {
      outcome: "registered",
      sourceId: row.source_id,
      attemptToken: row.current_attempt_token ?? null,
    };
  }
  if (row?.outcome === "reserved") {
    return {
      outcome: "reserved",
      sourceId: null,
      attemptToken: row.claimed_attempt_token ?? attemptToken,
    };
  }
  if (row?.outcome === "busy") {
    return { outcome: "busy", sourceId: null, attemptToken: null };
  }
  return { outcome: "conflict", sourceId: null, attemptToken: null };
}

/** Release only this owner's still-pending reservation after route failure. */
export async function releaseBlobReservation(
  userId: string,
  reviewerId: string,
  pathname: string,
  attemptToken: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE blob_reservations AS br
    SET state = 'released'::blob_reservation_state,
        lease_expires_at = NOW(),
        updated_at = NOW()
    WHERE br.user_id = ${userId}
      AND br.reviewer_id = ${reviewerId}
      AND br.pathname = ${pathname}
      AND br.attempt_token = ${attemptToken}
      AND br.state = 'reserved'::blob_reservation_state
      AND NOT EXISTS (
        SELECT 1 FROM sources AS s
        WHERE s.blob_pathname = br.pathname
      )
    RETURNING br.pathname
  `);
  return result.rows.length > 0;
}

/** Mark every source in a deletion tombstone before external Blob work. */
export async function markSourcesDeletingForReviewer(
  reviewerId: string,
  userId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE sources AS s
    SET deleting_at = COALESCE(s.deleting_at, NOW())
    FROM reviewers AS r
    INNER JOIN topics AS t ON t.id = r.topic_id
    WHERE s.reviewer_id = r.id
      AND r.id = ${reviewerId}
      AND t.user_id = ${userId}
  `);
  await db.execute(sql`
    UPDATE blob_reservations AS br
    SET state = 'released'::blob_reservation_state,
        attempt_token = ${crypto.randomUUID()},
        lease_expires_at = NOW(),
        updated_at = NOW()
    WHERE br.reviewer_id = ${reviewerId}
      AND br.user_id = ${userId}
      AND br.state = 'reserved'::blob_reservation_state
  `);
}

export async function markSourcesDeletingForTopic(
  topicId: string,
  userId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE sources AS s
    SET deleting_at = COALESCE(s.deleting_at, NOW())
    FROM reviewers AS r
    INNER JOIN topics AS t ON t.id = r.topic_id
    WHERE s.reviewer_id = r.id
      AND r.topic_id = ${topicId}
      AND t.user_id = ${userId}
  `);
  await db.execute(sql`
    UPDATE blob_reservations AS br
    SET state = 'released'::blob_reservation_state,
        attempt_token = ${crypto.randomUUID()},
        lease_expires_at = NOW(),
        updated_at = NOW()
    WHERE br.reviewer_id IN (
      SELECT r.id FROM reviewers AS r
      INNER JOIN topics AS t ON t.id = r.topic_id
      WHERE r.topic_id = ${topicId} AND t.user_id = ${userId}
    )
      AND br.user_id = ${userId}
      AND br.state = 'reserved'::blob_reservation_state
  `);
}

/** Return pending uploads as well as source rows for reconciliation. */
export async function listBlobReservationsForReviewer(
  reviewerId: string,
  userId: string,
): Promise<Array<{
  pathname: string;
  attemptToken: string;
  state: string;
  leaseExpiresAt: Date;
}>> {
  const rows = await db
    .select({
      pathname: blobReservations.pathname,
      attemptToken: blobReservations.attemptToken,
      state: blobReservations.state,
      leaseExpiresAt: blobReservations.leaseExpiresAt,
    })
    .from(blobReservations)
    .where(
      and(
        eq(blobReservations.reviewerId, reviewerId),
        eq(blobReservations.userId, userId),
      ),
    );
  return rows;
}

/**
 * Claim provider deletion only when the database says it is safe. The claim
 * leaves a durable deleting lease, so a provider failure or process crash is
 * retryable without allowing reconciliation to race a legitimate source.
 */
export async function claimBlobDeletion(
  userId: string,
  reviewerId: string,
  pathname: string,
  allowDeletingSource: boolean,
): Promise<{ attemptToken: string } | null> {
  // Every external delete gets a new opaque token. A stale provider call can
  // therefore never complete or requeue a later replacement reservation.
  const attemptToken = crypto.randomUUID();
  const result = await db.execute(sql`
    WITH owner_reviewer AS MATERIALIZED (
      SELECT r.id
      FROM reviewers AS r
      INNER JOIN topics AS t ON t.id = r.topic_id
      WHERE r.id = ${reviewerId}
        AND t.user_id = ${userId}
      -- Source registration takes this same lock before checking its
      -- reservation. A cleanup claim must serialize with that final insert,
      -- otherwise a statement snapshot could insert a source after this
      -- claim has already authorized provider deletion.
      FOR UPDATE OF r, t
    ),
    source_refs AS MATERIALIZED (
      SELECT s.id, s.deleting_at
      FROM sources AS s
      INNER JOIN reviewers AS r ON r.id = s.reviewer_id
      INNER JOIN topics AS t ON t.id = r.topic_id
      INNER JOIN owner_reviewer AS owner ON owner.id = r.id
      WHERE s.blob_pathname = ${pathname}
        AND t.user_id = ${userId}
        AND r.id = ${reviewerId}
    ),
    foreign_source_refs AS MATERIALIZED (
      SELECT s.id
      FROM sources AS s
      WHERE s.blob_pathname = ${pathname}
        AND NOT EXISTS (SELECT 1 FROM source_refs AS sr WHERE sr.id = s.id)
    ),
    reservation_refs AS MATERIALIZED (
      SELECT br.user_id, br.reviewer_id, br.pathname, br.state, br.lease_expires_at
      FROM blob_reservations AS br
      WHERE br.pathname = ${pathname}
    ),
    foreign_reservation_refs AS MATERIALIZED (
      SELECT 1
      FROM reservation_refs AS rr
      WHERE rr.user_id <> ${userId} OR rr.reviewer_id <> ${reviewerId}
    ),
    claimed_sources AS (
      UPDATE sources AS s
      SET deleting_at = COALESCE(s.deleting_at, NOW())
      WHERE s.id IN (SELECT sr.id FROM source_refs AS sr)
        AND ${allowDeletingSource}
        AND NOT EXISTS (SELECT 1 FROM foreign_source_refs)
      RETURNING s.id
    ),
    claimed_reservations AS (
      UPDATE blob_reservations AS br
      SET state = 'deleting'::blob_reservation_state,
          attempt_token = ${attemptToken},
          lease_expires_at = NOW() + INTERVAL '15 minutes',
          updated_at = NOW()
      WHERE br.pathname = ${pathname}
        AND br.user_id = ${userId}
        AND br.reviewer_id = ${reviewerId}
        AND (
          (br.state IN ('released'::blob_reservation_state, 'reserved'::blob_reservation_state)
            AND (br.lease_expires_at <= NOW() OR EXISTS (SELECT 1 FROM claimed_sources)))
          OR (br.state = 'deleting'::blob_reservation_state
            AND br.lease_expires_at <= NOW())
        )
        AND NOT EXISTS (SELECT 1 FROM foreign_reservation_refs)
      RETURNING br.pathname, br.attempt_token
    ),
    created_reservations AS (
      -- Orphans and legacy source rows may have no reservation yet. Create a
      -- deleting lease before the provider call so a new upload cannot claim
      -- the same pathname while this delete is still in flight.
      INSERT INTO blob_reservations (
        user_id,
        reviewer_id,
        pathname,
        attempt_token,
        state,
        lease_expires_at,
        created_at,
        updated_at
      )
      SELECT
        ${userId},
        ${reviewerId},
        ${pathname},
        ${attemptToken},
        'deleting'::blob_reservation_state,
        NOW() + INTERVAL '15 minutes',
        NOW(),
        NOW()
      FROM owner_reviewer
      WHERE NOT EXISTS (SELECT 1 FROM reservation_refs)
        AND NOT EXISTS (SELECT 1 FROM foreign_reservation_refs)
        AND (
          NOT EXISTS (SELECT 1 FROM source_refs)
          OR ${allowDeletingSource}
        )
      ON CONFLICT (pathname) DO NOTHING
      RETURNING pathname, attempt_token
    )
    SELECT (
      EXISTS (SELECT 1 FROM owner_reviewer)
      AND
      NOT EXISTS (SELECT 1 FROM foreign_source_refs)
      AND NOT EXISTS (SELECT 1 FROM foreign_reservation_refs)
      AND (
        EXISTS (SELECT 1 FROM claimed_sources)
        OR (
          NOT EXISTS (SELECT 1 FROM source_refs)
          AND (
            EXISTS (SELECT 1 FROM claimed_reservations)
            OR EXISTS (SELECT 1 FROM created_reservations)
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM reservation_refs AS rr
        WHERE NOT EXISTS (
          SELECT 1 FROM claimed_reservations AS cr
          WHERE cr.pathname = rr.pathname
        )
      )
    ) AS allowed,
    COALESCE(
      (SELECT cr.attempt_token FROM claimed_reservations AS cr LIMIT 1),
      (SELECT cr.attempt_token FROM created_reservations AS cr LIMIT 1)
    ) AS attempt_token
  `);
  const row = result.rows[0] as
    | { allowed?: boolean; attempt_token?: string | null }
    | undefined;
  if (!row?.allowed) return null;
  return row.attempt_token ? { attemptToken: row.attempt_token } : null;
}

/** Remove the reservation after a provider deletion when no source remains. */
export async function completeBlobDeletion(
  userId: string,
  reviewerId: string,
  pathname: string,
  attemptToken: string,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM blob_reservations AS br
    WHERE br.user_id = ${userId}
      AND br.reviewer_id = ${reviewerId}
      AND br.pathname = ${pathname}
      AND br.attempt_token = ${attemptToken}
      AND br.state = 'deleting'::blob_reservation_state
      AND NOT EXISTS (SELECT 1 FROM sources AS s WHERE s.blob_pathname = br.pathname)
  `);
}

/** Return an unregistered deletion claim to the retryable released state. */
export async function requeueBlobDeletion(
  userId: string,
  reviewerId: string,
  pathname: string,
  attemptToken: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE blob_reservations AS br
    SET state = 'released'::blob_reservation_state,
        lease_expires_at = NOW(),
        updated_at = NOW()
    WHERE br.user_id = ${userId}
      AND br.reviewer_id = ${reviewerId}
      AND br.pathname = ${pathname}
      AND br.attempt_token = ${attemptToken}
      AND br.state = 'deleting'::blob_reservation_state
      AND NOT EXISTS (SELECT 1 FROM sources AS s WHERE s.blob_pathname = br.pathname)
  `);
}

/** Source rows for UI/list APIs. Omits lecture-sized extractedText. */
export async function listSourcesForUi(reviewerId: string, userId: string) {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  const rows = await db
    .select({
      id: sources.id,
      reviewerId: sources.reviewerId,
      filename: sources.filename,
      mime: sources.mime,
      kind: sources.kind,
      blobUrl: sources.blobUrl,
      blobPathname: sources.blobPathname,
      ingestStatus: sources.ingestStatus,
      errorMessage: sources.errorMessage,
      deletingAt: sources.deletingAt,
      createdAt: sources.createdAt,
    })
    .from(sources)
    .where(eq(sources.reviewerId, reviewerId))
    .orderBy(asc(sources.createdAt));
  return rows.map((row) => ({
    ...row,
    errorMessage: publicSourceErrorMessage(row.errorMessage),
  }));
}

/** View identity and timestamps only. No markdown/JSON bodies. */
export async function listViewMetaByReviewer(reviewerId: string, userId: string) {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  return db
    .select({
      id: views.id,
      reviewerId: views.reviewerId,
      kind: views.kind,
      modelId: views.modelId,
      generatedAt: views.generatedAt,
      contentRevision: views.contentRevision,
      annotationRevision: views.annotationRevision,
      revision: views.revision,
      isEdited: views.isEdited,
      isPinned: views.isPinned,
      updatedAt: views.updatedAt,
    })
    .from(views)
    .where(eq(views.reviewerId, reviewerId));
}

function serializeAnnotationRow(row: {
  id: string;
  reviewerId: string;
  viewId: string;
  kind: "locked_in" | "summary";
  contentRevision: number;
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix: string;
  suffix: string;
  color: AnnotationColor;
  note: string | null;
  archivedAt: Date | null;
  archiveReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AnnotationRecord {
  return {
    ...row,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List annotations only through the authenticated reviewer's owner boundary. */
export async function listAnnotationsForReviewer(
  reviewerId: string,
  userId: string,
  kind?: "locked_in" | "summary",
  options?: { activeOnly?: boolean },
): Promise<AnnotationRecord[]> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  const rows = await db
    .select({
      id: annotations.id,
      reviewerId: annotations.reviewerId,
      viewId: annotations.viewId,
      kind: annotations.kind,
      contentRevision: annotations.contentRevision,
      startOffset: annotations.startOffset,
      endOffset: annotations.endOffset,
      quote: annotations.quote,
      prefix: annotations.prefix,
      suffix: annotations.suffix,
      color: annotations.color,
      note: annotations.note,
      archivedAt: annotations.archivedAt,
      archiveReason: annotations.archiveReason,
      createdAt: annotations.createdAt,
      updatedAt: annotations.updatedAt,
    })
    .from(annotations)
    .innerJoin(views, eq(views.id, annotations.viewId))
    .where(
      and(
        eq(annotations.reviewerId, reviewerId),
        eq(annotations.userId, userId),
        kind ? eq(views.kind, kind) : undefined,
        options?.activeOnly ? isNull(annotations.archivedAt) : undefined,
      ),
    )
    .orderBy(asc(annotations.createdAt));
  return rows.map((row) => serializeAnnotationRow(row));
}

type AnnotationPageOptions = {
  earlierOnly?: boolean;
  cursor?: string;
  limit?: number;
};

function decodeAnnotationCursor(cursor: string | undefined): { archivedAt: Date; id: string } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) return null;
  const archivedAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  return Number.isNaN(archivedAt.getTime()) || !id ? null : { archivedAt, id };
}

/**
 * Return active annotations plus a bounded page of Earlier version rows. The
 * cursor is an opaque timestamp/id pair; rows are never dropped to fit the
 * UI limit and can be fetched again from the authenticated owner boundary.
 */
export async function listAnnotationPageForReviewer(
  reviewerId: string,
  userId: string,
  kind: "locked_in" | "summary",
  options: AnnotationPageOptions = {},
): Promise<{ annotations: AnnotationRecord[]; nextCursor: string | null }> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return { annotations: [], nextCursor: null };
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const cursor = decodeAnnotationCursor(options.cursor);
  const ownerWhere = and(
    eq(annotations.reviewerId, reviewerId),
    eq(annotations.userId, userId),
    eq(annotations.kind, kind),
  );

  const selectRows = () => db.select({
    id: annotations.id,
    reviewerId: annotations.reviewerId,
    viewId: annotations.viewId,
    kind: annotations.kind,
    contentRevision: annotations.contentRevision,
    startOffset: annotations.startOffset,
    endOffset: annotations.endOffset,
    quote: annotations.quote,
    prefix: annotations.prefix,
    suffix: annotations.suffix,
    color: annotations.color,
    note: annotations.note,
    archivedAt: annotations.archivedAt,
    archiveReason: annotations.archiveReason,
    createdAt: annotations.createdAt,
    updatedAt: annotations.updatedAt,
  }).from(annotations);

  if (options.earlierOnly) {
    const rows = await selectRows()
      .where(and(ownerWhere, sql`${annotations.archivedAt} IS NOT NULL`, cursor ? sql`(
        ${annotations.archivedAt} < ${cursor.archivedAt}
        OR (${annotations.archivedAt} = ${cursor.archivedAt} AND ${annotations.id} < ${cursor.id})
      )` : undefined))
      .orderBy(desc(annotations.archivedAt), desc(annotations.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const last = visibleRows[visibleRows.length - 1];
    return {
      annotations: visibleRows.map((row) => serializeAnnotationRow(row)),
      nextCursor: hasMore && last?.archivedAt ? `${last.archivedAt.toISOString()}|${last.id}` : null,
    };
  }

  const [activeRows, earlierPage] = await Promise.all([
    selectRows()
      .where(and(ownerWhere, isNull(annotations.archivedAt)))
      .orderBy(asc(annotations.createdAt)),
    listAnnotationPageForReviewer(reviewerId, userId, kind, { ...options, earlierOnly: true }),
  ]);
  return {
    annotations: [...activeRows.map((row) => serializeAnnotationRow(row)), ...earlierPage.annotations],
    nextCursor: earlierPage.nextCursor,
  };
}

export async function saveAnnotations(args: {
  reviewerId: string;
  userId: string;
  kind: "locked_in" | "summary";
  expectedRevision: number;
  expectedContentRevision: number;
  expectedAnnotationRevision: number;
  items: Array<{
    startOffset: number;
    endOffset: number;
    quote: string;
    prefix: string;
    suffix: string;
    color: AnnotationColor;
    note: string | null;
  }>;
}): Promise<{
  viewRevision: number;
  contentRevision: number;
  annotationRevision: number;
} | null> {
  if (args.items.length === 0 || args.items.length > MAX_ACTIVE_ANNOTATIONS) return null;
  const result = await db.execute(sql`
    WITH input AS (
      SELECT item.start_offset,
        item.end_offset,
        item.quote,
        item.prefix,
        item.suffix,
        item.color::annotation_color AS color,
        NULLIF(item.note, '') AS note,
        item.ordinality
      FROM ROWS FROM(
        jsonb_to_recordset(CAST(${JSON.stringify(annotationSaveRows(args.items))} AS jsonb))
          AS (
            start_offset integer,
            end_offset integer,
            quote text,
            prefix text,
            suffix text,
            color text,
            note text
          )
      ) WITH ORDINALITY AS item(
        start_offset,
        end_offset,
        quote,
        prefix,
        suffix,
        color,
        note,
        ordinality
      )
    ), target AS MATERIALIZED (
      SELECT v.id,
        v.reviewer_id,
        v.kind,
        v.content_revision,
        v.annotation_revision,
        v.revision
      FROM views v
      INNER JOIN reviewers r ON r.id = v.reviewer_id
      INNER JOIN topics t ON t.id = r.topic_id
      WHERE v.reviewer_id = ${args.reviewerId}
        AND t.user_id = ${args.userId}
        AND v.kind = ${args.kind}::view_kind
        AND v.revision = ${args.expectedRevision}
        AND v.content_revision = ${args.expectedContentRevision}
        AND v.annotation_revision = ${args.expectedAnnotationRevision}
      FOR UPDATE OF v
    ), active_count AS (
      SELECT COUNT(*)::integer AS count
      FROM study_annotations a
      INNER JOIN target ON target.id = a.view_id
      WHERE a.archived_at IS NULL
    ), overlap_guard AS (
      SELECT target.id
      FROM target
      WHERE NOT EXISTS (
        SELECT 1
        FROM input left_input
        INNER JOIN input right_input
          ON left_input.start_offset < right_input.end_offset
         AND right_input.start_offset < left_input.end_offset
         AND left_input.ordinality < right_input.ordinality
      )
        AND NOT EXISTS (
          SELECT 1
          FROM input
          INNER JOIN study_annotations existing
            ON existing.view_id = target.id
           AND existing.archived_at IS NULL
           AND input.start_offset < existing.end_offset
           AND existing.start_offset < input.end_offset
        )
        AND NOT EXISTS (
          SELECT 1
          FROM input
          WHERE input.start_offset < 0
             OR input.end_offset <= input.start_offset
             OR input.quote = ''
        )
    ), updated_view AS (
      UPDATE views v
      SET revision = v.revision + 1,
          annotation_revision = v.annotation_revision + 1,
          updated_at = NOW()
      FROM target, active_count, overlap_guard
      WHERE v.id = target.id
        AND overlap_guard.id = target.id
        AND active_count.count + (SELECT COUNT(*)::integer FROM input) <= ${MAX_ACTIVE_ANNOTATIONS}
      RETURNING v.revision, v.content_revision, v.annotation_revision
    ), inserted AS (
      INSERT INTO study_annotations (
        user_id,
        reviewer_id,
        view_id,
        kind,
        content_revision,
        start_offset,
        end_offset,
        quote,
        prefix,
        suffix,
        color,
        note
      )
      SELECT ${args.userId},
        ${args.reviewerId},
        target.id,
        ${args.kind}::annotation_view_kind,
        target.content_revision,
        input.start_offset,
        input.end_offset,
        input.quote,
        input.prefix,
        input.suffix,
        input.color,
        input.note
      FROM target
      INNER JOIN updated_view ON TRUE
      CROSS JOIN input
      RETURNING id
    )
    SELECT updated_view.revision,
      updated_view.content_revision,
      updated_view.annotation_revision,
      (SELECT COUNT(*)::integer FROM inserted) AS inserted_count
    FROM updated_view
  `);
  const row = result.rows[0] as {
    revision?: number;
    content_revision?: number;
    annotation_revision?: number;
  } | undefined;
  if (
    typeof row?.revision !== "number" ||
    typeof row.content_revision !== "number" ||
    typeof row.annotation_revision !== "number"
  ) return null;
  return {
    viewRevision: row.revision,
    contentRevision: row.content_revision,
    annotationRevision: row.annotation_revision,
  };
}

export async function getViewForReviewer(
  reviewerId: string,
  userId: string,
  kind: "locked_in" | "summary" | "test_me" | "carded",
) {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return null;
  return getLatestView(reviewerId, kind);
}

export type TimedTestSessionRow = {
  id: string;
  userId: string;
  reviewerId: string;
  viewRevision: number;
  startedAt: Date;
  expiresAt: Date;
  status: "active" | "completed" | "expired";
  completedAt: Date | null;
  answeredCount: number;
  answeredItemIds: string[];
};

function asSessionDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timed session ${field}`);
  return date;
}

function asAnsweredItemIds(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      parsed = [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeTimedSessionRow(row: Record<string, unknown>): TimedTestSessionRow {
  const status = row.status;
  if (status !== "active" && status !== "completed" && status !== "expired") {
    throw new Error("Invalid timed session status");
  }
  const viewRevision = Number(row.view_revision ?? row.viewRevision);
  if (!Number.isSafeInteger(viewRevision) || viewRevision < 1) {
    throw new Error("Invalid timed session revision");
  }
  const answeredCount = Number(row.answered_count ?? row.answeredCount ?? 0);
  if (!Number.isSafeInteger(answeredCount) || answeredCount < 0) {
    throw new Error("Invalid timed session progress");
  }
  return {
    id: String(row.id),
    userId: String(row.user_id ?? row.userId),
    reviewerId: String(row.reviewer_id ?? row.reviewerId),
    viewRevision,
    startedAt: asSessionDate(row.started_at ?? row.startedAt, "start"),
    expiresAt: asSessionDate(row.expires_at ?? row.expiresAt, "deadline"),
    status,
    completedAt:
      row.completed_at ?? row.completedAt
        ? asSessionDate(row.completed_at ?? row.completedAt, "completion")
        : null,
    answeredCount,
    answeredItemIds: asAnsweredItemIds(row.answered_item_ids ?? row.answeredItemIds),
  };
}

async function expireTimedSessions(
  userId: string,
  reviewerId: string,
  expectedRevision: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE test_sessions
    SET status = 'expired'::test_session_status,
        completed_at = COALESCE(completed_at, NOW()),
        updated_at = NOW()
    WHERE user_id = ${userId}
      AND reviewer_id = ${reviewerId}
      AND status = 'active'::test_session_status
      AND (
        view_revision <> ${expectedRevision}
        OR (
          mode = 'timed'::test_session_mode
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        )
      )
  `);
}

/** Maintenance hook for pruning the active state of abandoned timed runs. */
export async function cleanupExpiredTimedTestSessions(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE test_sessions
    SET status = 'expired'::test_session_status,
        completed_at = COALESCE(completed_at, NOW()),
        updated_at = NOW()
    WHERE status = 'active'::test_session_status
      AND mode = 'timed'::test_session_mode
      AND expires_at IS NOT NULL
      AND expires_at <= NOW()
    RETURNING id
  `);
  return result.rows.length;
}

/** Return an existing active server-side run without creating a new nonce. */
export async function getActiveTimedTestSession(args: {
  userId: string;
  reviewerId: string;
  expectedRevision: number;
}): Promise<TimedTestSessionRow | null> {
  const view = await getViewForReviewer(args.reviewerId, args.userId, "test_me");
  if (!view || view.revision !== args.expectedRevision) return null;
  await expireTimedSessions(args.userId, args.reviewerId, args.expectedRevision);
  const [row] = await db
    .select()
    .from(testSessions)
    .where(
      and(
        eq(testSessions.userId, args.userId),
        eq(testSessions.reviewerId, args.reviewerId),
        eq(testSessions.viewRevision, args.expectedRevision),
        eq(testSessions.status, "active"),
        eq(testSessions.mode, "timed"),
        gt(testSessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(testSessions.startedAt))
    .limit(1);
  if (!row || !row.expiresAt) return null;
  const attempts = await db
    .select({ itemId: testAttempts.itemId })
    .from(testAttempts)
    .where(eq(testAttempts.sessionId, row.id));
  return {
    id: row.id,
    userId: row.userId,
    reviewerId: row.reviewerId,
    viewRevision: row.viewRevision,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
    status: row.status,
    completedAt: row.completedAt,
    answeredCount: row.answeredCount,
    answeredItemIds: attempts.map((attempt) => attempt.itemId),
  };
}

/** Atomically create or resume the one active run for this owner/revision. */
export async function createOrResumeTimedTestSession(args: {
  userId: string;
  reviewerId: string;
  expectedRevision: number;
  durationSeconds: number;
}): Promise<TimedTestSessionRow | null> {
  const view = await getViewForReviewer(args.reviewerId, args.userId, "test_me");
  if (!view || view.revision !== args.expectedRevision) return null;
  if (parseTestMeItems(view.contentJson, view.content).length === 0) return null;
  const result = await db.execute(sql`
    WITH expired AS MATERIALIZED (
      UPDATE test_sessions
      SET status = 'expired'::test_session_status,
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW()
      WHERE user_id = ${args.userId}
        AND reviewer_id = ${args.reviewerId}
        AND status = 'active'::test_session_status
        AND (
          view_revision <> ${args.expectedRevision}
          OR (
            mode = 'timed'::test_session_mode
            AND expires_at IS NOT NULL
            AND expires_at <= NOW()
          )
        )
      RETURNING id
    ),
    current_view AS MATERIALIZED (
      SELECT v.revision
      FROM views AS v
      WHERE v.reviewer_id = ${args.reviewerId}
        AND v.kind = 'test_me'::view_kind
        AND v.revision = ${args.expectedRevision}
      FOR UPDATE
    ),
    claimed AS (
      INSERT INTO test_sessions (
        user_id,
        reviewer_id,
        view_revision,
        mode,
        started_at,
        expires_at,
        item_ids,
        status,
        created_at,
        updated_at
      )
      SELECT
        ${args.userId},
        ${args.reviewerId},
        current_view.revision,
        'timed'::test_session_mode,
        NOW(),
        NOW() + (${args.durationSeconds} * INTERVAL '1 second'),
        '[]'::jsonb,
        'active'::test_session_status,
        NOW(),
        NOW()
      FROM current_view
      CROSS JOIN (SELECT COUNT(*) AS cleanup_count FROM expired) AS cleanup
      ON CONFLICT (user_id, reviewer_id, mode)
        WHERE status = 'active'::test_session_status
      DO UPDATE SET updated_at = test_sessions.updated_at
      RETURNING
        id,
        user_id,
        reviewer_id,
        view_revision,
        started_at,
        expires_at,
        status,
        completed_at,
        answered_count
    )
    SELECT
      claimed.id,
      claimed.user_id,
      claimed.reviewer_id,
      claimed.view_revision,
      claimed.started_at,
      claimed.expires_at,
      claimed.status,
      claimed.completed_at,
      claimed.answered_count,
      COALESCE(
        (
          SELECT JSON_AGG(a.item_id ORDER BY a.attempted_at)
          FROM test_attempts AS a
          WHERE a.session_id = claimed.id
        ),
        '[]'::json
      ) AS answered_item_ids
    FROM claimed
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? normalizeTimedSessionRow(row) : null;
}

export type TimedTestAttemptResult =
  | { stats: TestAttemptStats[]; alreadySaved: boolean; completed: boolean }
  | { missing: true }
  | { stale: true }
  | { expired: true }
  | { conflict: true };

/**
 * Record one timed answer under a locked session row. The partial unique key
 * makes retries idempotent, while the no-op upsert returns the original answer
 * so a conflicting second tab can never overwrite it.
 */
export async function recordTimedTestAttempt(args: {
  reviewerId: string;
  userId: string;
  sessionId: string;
  expectedRevision: number;
  itemId: string;
  selectedAnswer: string;
}): Promise<TimedTestAttemptResult> {
  if (args.selectedAnswer.length > MAX_TEST_ATTEMPT_SELECTED_ANSWER_CHARS) {
    throw new Error("Selected answer exceeds the safe size limit");
  }
  const view = await getViewForReviewer(args.reviewerId, args.userId, "test_me");
  if (!view) return { missing: true };
  if (view.revision !== args.expectedRevision) return { stale: true };
  const items = parseTestMeItems(view.contentJson, view.content);
  const item = items.find((candidate) => candidate.id === args.itemId);
  if (!item) throw new Error("Unknown test item");
  const correct = args.selectedAnswer.trim().toLowerCase() === item.answer.trim().toLowerCase();
  const result = await db.execute(sql`
    WITH expired AS MATERIALIZED (
      UPDATE test_sessions
      SET status = 'expired'::test_session_status,
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW()
      WHERE id = ${args.sessionId}
        AND user_id = ${args.userId}
        AND reviewer_id = ${args.reviewerId}
        AND status = 'active'::test_session_status
        AND mode = 'timed'::test_session_mode
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
      RETURNING id
    ),
    locked_session AS MATERIALIZED (
      SELECT ts.id
      FROM test_sessions AS ts
      WHERE ts.id = ${args.sessionId}
        AND ts.user_id = ${args.userId}
        AND ts.reviewer_id = ${args.reviewerId}
        AND ts.view_revision = ${args.expectedRevision}
        AND ts.mode = 'timed'::test_session_mode
        AND ts.status = 'active'::test_session_status
        AND ts.expires_at IS NOT NULL
        AND ts.expires_at > NOW()
      FOR UPDATE
    ),
    existing_attempt AS MATERIALIZED (
      SELECT a.selected_answer
      FROM test_attempts AS a
      WHERE a.session_id = ${args.sessionId}
        AND a.item_id = ${args.itemId}
      LIMIT 1
    ),
    current_view AS MATERIALIZED (
      SELECT v.revision
      FROM views AS v
      WHERE v.reviewer_id = ${args.reviewerId}
        AND v.kind = 'test_me'::view_kind
        AND v.revision = ${args.expectedRevision}
      FOR UPDATE
    ),
    written AS (
      INSERT INTO test_attempts (
        user_id,
        reviewer_id,
        session_id,
        view_revision,
        item_id,
        selected_answer,
        correct
      )
      SELECT
        ${args.userId},
        ${args.reviewerId},
        locked_session.id,
        current_view.revision,
        ${args.itemId},
        ${args.selectedAnswer},
        ${correct}
      FROM locked_session
      CROSS JOIN current_view
      ON CONFLICT (session_id, item_id)
        WHERE session_id IS NOT NULL
      DO UPDATE SET
        selected_answer = test_attempts.selected_answer,
        correct = test_attempts.correct,
        attempted_at = test_attempts.attempted_at
      RETURNING
        id,
        selected_answer,
        correct,
        (xmax = 0) AS inserted
    ),
    progressed AS (
      UPDATE test_sessions AS ts
      SET answered_count = ts.answered_count + 1,
          status = CASE
            WHEN ts.answered_count + 1 >= ${items.length}
              THEN 'completed'::test_session_status
            ELSE 'active'::test_session_status
          END,
          completed_at = CASE
            WHEN ts.answered_count + 1 >= ${items.length}
              THEN NOW()
            ELSE ts.completed_at
          END,
          updated_at = NOW()
      WHERE ts.id = ${args.sessionId}
        AND ts.status = 'active'::test_session_status
        AND EXISTS (SELECT 1 FROM written AS w WHERE w.inserted)
      RETURNING status, answered_count, completed_at
    )
    SELECT
      CASE
        WHEN EXISTS (SELECT 1 FROM written)
          THEN 'written'
        WHEN EXISTS (SELECT 1 FROM expired)
          THEN 'expired'
        WHEN EXISTS (
          SELECT 1 FROM test_sessions AS ts
          WHERE ts.id = ${args.sessionId}
            AND ts.user_id = ${args.userId}
            AND ts.reviewer_id = ${args.reviewerId}
            AND ts.status = 'completed'::test_session_status
        ) THEN 'completed'
        WHEN EXISTS (SELECT 1 FROM locked_session)
          THEN 'stale'
        ELSE 'missing'
      END AS outcome,
      COALESCE(
        (SELECT w.selected_answer FROM written AS w LIMIT 1),
        (SELECT a.selected_answer FROM existing_attempt AS a LIMIT 1)
      ) AS selected_answer,
      COALESCE((SELECT w.inserted FROM written AS w LIMIT 1), FALSE) AS inserted,
      EXISTS (
        SELECT 1
        FROM progressed AS p
        WHERE p.status = 'completed'::test_session_status
      ) AS completed
  `);
  const row = result.rows[0] as
    | { outcome?: string; selected_answer?: string; inserted?: boolean; completed?: boolean }
    | undefined;
  if (row?.outcome === "expired") return { expired: true };
  if (row?.outcome === "stale") return { stale: true };
  if (row?.outcome !== "written" || typeof row.selected_answer !== "string") {
    // A competing request can win the session row lock, insert the final
    // answer, and complete the session before this statement gets to run.
    // The original statement snapshot may then report no locked session and
    // no attempt. Re-read the committed state in a fresh statement so a
    // duplicate/concurrent replay is never misreported as missing.
    const [currentSession] = await db
      .select({
        status: testSessions.status,
        viewRevision: testSessions.viewRevision,
        expiresAt: testSessions.expiresAt,
      })
      .from(testSessions)
      .where(
        and(
          eq(testSessions.id, args.sessionId),
          eq(testSessions.userId, args.userId),
          eq(testSessions.reviewerId, args.reviewerId),
        ),
      )
      .limit(1);
    if (!currentSession) return { missing: true };
    if (currentSession.viewRevision !== args.expectedRevision) return { stale: true };
    if (
      currentSession.status === "expired"
      || (currentSession.expiresAt != null && currentSession.expiresAt <= new Date())
    ) {
      return { expired: true };
    }
    const [existing] = await db
      .select({ selectedAnswer: testAttempts.selectedAnswer })
      .from(testAttempts)
      .where(
        and(
          eq(testAttempts.sessionId, args.sessionId),
          eq(testAttempts.itemId, args.itemId),
        ),
      )
      .limit(1);
    if (!existing) {
      // A completed session with no row for this item indicates an invalid or
      // already exhausted client claim. Do not pretend that an answer was
      // saved; force the caller onto the explicit conflict path.
      return currentSession.status === "completed"
        ? { conflict: true }
        : { missing: true };
    }
    if (existing.selectedAnswer !== args.selectedAnswer) return { conflict: true };
    return {
      stats: await listTestAttemptStats(args.reviewerId, args.userId),
      alreadySaved: true,
      completed: currentSession.status === "completed",
    };
  }
  if (row.selected_answer !== args.selectedAnswer) return { conflict: true };
  let completed = row.completed === true;
  if (!completed) {
    const [currentSession] = await db
      .select({ status: testSessions.status })
      .from(testSessions)
      .where(
        and(
          eq(testSessions.id, args.sessionId),
          eq(testSessions.userId, args.userId),
          eq(testSessions.reviewerId, args.reviewerId),
        ),
      )
      .limit(1);
    completed = currentSession?.status === "completed";
  }
  return {
    stats: await listTestAttemptStats(args.reviewerId, args.userId),
    alreadySaved: row.inserted !== true,
    completed,
  };
}

export type UntimedPracticeAnswerRow = {
  itemId: string;
  selectedAnswer: string;
  correct: boolean;
};

export type UntimedPracticeSessionRow = {
  id: string;
  userId: string;
  reviewerId: string;
  viewRevision: number;
  startedAt: Date;
  expiresAt: null;
  status: "active" | "completed" | "expired";
  completedAt: Date | null;
  answeredCount: number;
  itemIds: string[];
  originSessionId: string | null;
  answers: UntimedPracticeAnswerRow[];
};

function asItemIds(value: unknown): string[] {
  return asAnsweredItemIds(value);
}

async function loadUntimedSessionAnswers(sessionId: string): Promise<UntimedPracticeAnswerRow[]> {
  const rows = await db
    .select({
      itemId: testAttempts.itemId,
      selectedAnswer: testAttempts.selectedAnswer,
      correct: testAttempts.correct,
    })
    .from(testAttempts)
    .where(eq(testAttempts.sessionId, sessionId))
    .orderBy(asc(testAttempts.attemptedAt));
  return rows;
}

function normalizeUntimedSessionRow(
  row: {
    id: string;
    userId: string;
    reviewerId: string;
    viewRevision: number;
    startedAt: Date;
    expiresAt: Date | null;
    status: "active" | "completed" | "expired";
    completedAt: Date | null;
    answeredCount: number;
    itemIds: unknown;
    originSessionId: string | null;
  },
  answers: UntimedPracticeAnswerRow[],
): UntimedPracticeSessionRow | null {
  if (row.expiresAt != null) return null;
  return {
    id: row.id,
    userId: row.userId,
    reviewerId: row.reviewerId,
    viewRevision: row.viewRevision,
    startedAt: row.startedAt,
    expiresAt: null,
    status: row.status,
    completedAt: row.completedAt,
    answeredCount: row.answeredCount,
    itemIds: asItemIds(row.itemIds),
    originSessionId: row.originSessionId,
    answers,
  };
}

async function hydrateUntimedSession(
  row: {
    id: string;
    userId: string;
    reviewerId: string;
    viewRevision: number;
    startedAt: Date;
    expiresAt: Date | null;
    status: "active" | "completed" | "expired";
    completedAt: Date | null;
    answeredCount: number;
    itemIds: unknown;
    originSessionId: string | null;
  } | undefined,
): Promise<UntimedPracticeSessionRow | null> {
  if (!row || row.expiresAt != null) return null;
  return normalizeUntimedSessionRow(row, await loadUntimedSessionAnswers(row.id));
}

/** Resume the active untimed sitting, or the latest completed one at this revision. */
export async function getUntimedPracticeSession(args: {
  userId: string;
  reviewerId: string;
  expectedRevision: number;
}): Promise<UntimedPracticeSessionRow | null> {
  const view = await getViewForReviewer(args.reviewerId, args.userId, "test_me");
  if (!view || view.revision !== args.expectedRevision) return null;
  await expireTimedSessions(args.userId, args.reviewerId, args.expectedRevision);
  const [active] = await db
    .select()
    .from(testSessions)
    .where(
      and(
        eq(testSessions.userId, args.userId),
        eq(testSessions.reviewerId, args.reviewerId),
        eq(testSessions.viewRevision, args.expectedRevision),
        eq(testSessions.status, "active"),
        eq(testSessions.mode, "untimed"),
        isNull(testSessions.expiresAt),
      ),
    )
    .orderBy(desc(testSessions.startedAt))
    .limit(1);
  if (active) return hydrateUntimedSession(active);
  const [completed] = await db
    .select()
    .from(testSessions)
    .where(
      and(
        eq(testSessions.userId, args.userId),
        eq(testSessions.reviewerId, args.reviewerId),
        eq(testSessions.viewRevision, args.expectedRevision),
        eq(testSessions.status, "completed"),
        eq(testSessions.mode, "untimed"),
        isNull(testSessions.expiresAt),
      ),
    )
    .orderBy(desc(testSessions.completedAt), desc(testSessions.startedAt))
    .limit(1);
  return hydrateUntimedSession(completed);
}

async function insertUntimedPracticeSession(args: {
  userId: string;
  reviewerId: string;
  expectedRevision: number;
  itemIds: string[];
  originSessionId?: string | null;
  replaceActive?: boolean;
}): Promise<UntimedPracticeSessionRow | null> {
  const itemIdsJson = JSON.stringify(args.itemIds);
  const replaceActive = args.replaceActive === true ? sql`TRUE` : sql`FALSE`;
  const result = await db.execute(sql`
    WITH expired AS MATERIALIZED (
      UPDATE test_sessions
      SET status = 'expired'::test_session_status,
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW()
      WHERE user_id = ${args.userId}
        AND reviewer_id = ${args.reviewerId}
        AND status = 'active'::test_session_status
        AND (
          view_revision <> ${args.expectedRevision}
          OR (
            mode = 'timed'::test_session_mode
            AND expires_at IS NOT NULL
            AND expires_at <= NOW()
          )
          OR (
            ${replaceActive}
            AND mode = 'untimed'::test_session_mode
          )
        )
      RETURNING id
    ),
    current_view AS MATERIALIZED (
      SELECT v.revision
      FROM views AS v
      WHERE v.reviewer_id = ${args.reviewerId}
        AND v.kind = 'test_me'::view_kind
        AND v.revision = ${args.expectedRevision}
      FOR UPDATE
    ),
    claimed AS (
      INSERT INTO test_sessions (
        user_id,
        reviewer_id,
        view_revision,
        mode,
        started_at,
        expires_at,
        item_ids,
        origin_session_id,
        status,
        created_at,
        updated_at
      )
      SELECT
        ${args.userId},
        ${args.reviewerId},
        current_view.revision,
        'untimed'::test_session_mode,
        NOW(),
        NULL,
        CAST(${itemIdsJson} AS jsonb),
        ${args.originSessionId ?? null},
        'active'::test_session_status,
        NOW(),
        NOW()
      FROM current_view
      CROSS JOIN (SELECT COUNT(*) AS cleanup_count FROM expired) AS cleanup
      ON CONFLICT (user_id, reviewer_id, mode)
        WHERE status = 'active'::test_session_status
      DO UPDATE SET updated_at = test_sessions.updated_at
      RETURNING
        id,
        user_id,
        reviewer_id,
        view_revision,
        started_at,
        expires_at,
        item_ids,
        origin_session_id,
        status,
        completed_at,
        answered_count
    )
    SELECT * FROM claimed
  `);
  const raw = result.rows[0] as Record<string, unknown> | undefined;
  if (!raw) return null;
  const id = String(raw.id);
  const status = raw.status;
  if (status !== "active" && status !== "completed" && status !== "expired") return null;
  return hydrateUntimedSession({
    id,
    userId: String(raw.user_id ?? raw.userId),
    reviewerId: String(raw.reviewer_id ?? raw.reviewerId),
    viewRevision: Number(raw.view_revision ?? raw.viewRevision),
    startedAt: asSessionDate(raw.started_at ?? raw.startedAt, "start"),
    expiresAt: raw.expires_at ?? raw.expiresAt
      ? asSessionDate(raw.expires_at ?? raw.expiresAt, "deadline")
      : null,
    status,
    completedAt: raw.completed_at ?? raw.completedAt
      ? asSessionDate(raw.completed_at ?? raw.completedAt, "completion")
      : null,
    answeredCount: Number(raw.answered_count ?? raw.answeredCount ?? 0),
    itemIds: raw.item_ids ?? raw.itemIds,
    originSessionId: raw.origin_session_id == null && raw.originSessionId == null
      ? null
      : String(raw.origin_session_id ?? raw.originSessionId),
  });
}

export async function createOrResumeUntimedPracticeSession(args: {
  userId: string;
  reviewerId: string;
  expectedRevision: number;
}): Promise<UntimedPracticeSessionRow | null> {
  const existing = await getUntimedPracticeSession(args);
  if (existing) return existing;
  const view = await getViewForReviewer(args.reviewerId, args.userId, "test_me");
  if (!view || view.revision !== args.expectedRevision) return null;
  const itemIds = snapshotTestItemIds(parseTestMeItems(view.contentJson, view.content));
  if (itemIds.length === 0) return null;
  return insertUntimedPracticeSession({ ...args, itemIds });
}

export async function restartUntimedPracticeSession(args: {
  userId: string;
  reviewerId: string;
  expectedRevision: number;
}): Promise<UntimedPracticeSessionRow | null> {
  const view = await getViewForReviewer(args.reviewerId, args.userId, "test_me");
  if (!view || view.revision !== args.expectedRevision) return null;
  const itemIds = snapshotTestItemIds(parseTestMeItems(view.contentJson, view.content));
  if (itemIds.length === 0) return null;
  return insertUntimedPracticeSession({ ...args, itemIds, replaceActive: true });
}

export async function retryMissedUntimedPracticeSession(args: {
  userId: string;
  reviewerId: string;
  expectedRevision: number;
  originSessionId?: string;
}): Promise<UntimedPracticeSessionRow | { missing: true } | { empty: true } | { stale: true } | { conflict: true }> {
  const view = await getViewForReviewer(args.reviewerId, args.userId, "test_me");
  if (!view) return { missing: true };
  if (view.revision !== args.expectedRevision) return { stale: true };
  await expireTimedSessions(args.userId, args.reviewerId, args.expectedRevision);
  const origin = args.originSessionId
    ? await hydrateUntimedSession(
      (await db
        .select()
        .from(testSessions)
        .where(
          and(
            eq(testSessions.id, args.originSessionId),
            eq(testSessions.userId, args.userId),
            eq(testSessions.reviewerId, args.reviewerId),
            eq(testSessions.mode, "untimed"),
          ),
        )
        .limit(1))[0],
    )
    : await getUntimedPracticeSession(args);
  if (!origin) return { missing: true };
  if (origin.viewRevision !== args.expectedRevision) return { stale: true };
  if (origin.status !== "completed") return { missing: true };
  const itemIds = missedItemIds(origin.itemIds, origin.answers);
  if (itemIds.length === 0) return { empty: true };
  const [activeRow] = await db
    .select()
    .from(testSessions)
    .where(
      and(
        eq(testSessions.userId, args.userId),
        eq(testSessions.reviewerId, args.reviewerId),
        eq(testSessions.mode, "untimed"),
        eq(testSessions.status, "active"),
        isNull(testSessions.expiresAt),
      ),
    )
    .limit(1);
  if (activeRow && activeRow.id !== origin.id) {
    const active = await hydrateUntimedSession(activeRow);
    const sameRetry = Boolean(
      active
      && active.originSessionId === origin.id
      && sameItemSnapshot(active.itemIds, itemIds),
    );
    if (sameRetry && active) return active;
    return { conflict: true };
  }
  const created = await insertUntimedPracticeSession({
    ...args,
    itemIds,
    originSessionId: origin.id,
    replaceActive: true,
  });
  return created ?? { missing: true };
}

export type UntimedTestAttemptResult =
  | { stats: TestAttemptStats[]; alreadySaved: boolean; completed: boolean; answer: UntimedPracticeAnswerRow }
  | { missing: true }
  | { stale: true }
  | { conflict: true }
  | { invalid: true };

export async function recordUntimedTestAttempt(args: {
  reviewerId: string;
  userId: string;
  sessionId: string;
  expectedRevision: number;
  itemId: string;
  selectedAnswer: string;
}): Promise<UntimedTestAttemptResult> {
  if (args.selectedAnswer.length > MAX_TEST_ATTEMPT_SELECTED_ANSWER_CHARS) {
    throw new Error("Selected answer exceeds the safe size limit");
  }
  const view = await getViewForReviewer(args.reviewerId, args.userId, "test_me");
  if (!view) return { missing: true };
  if (view.revision !== args.expectedRevision) return { stale: true };
  const items = parseTestMeItems(view.contentJson, view.content);
  const item = items.find((candidate) => candidate.id === args.itemId);
  if (!item) throw new Error("Unknown test item");
  const correct = args.selectedAnswer.trim().toLowerCase() === item.answer.trim().toLowerCase();
  const result = await db.execute(sql`
    WITH locked_session AS MATERIALIZED (
      SELECT ts.id, ts.item_ids
      FROM test_sessions AS ts
      WHERE ts.id = ${args.sessionId}
        AND ts.user_id = ${args.userId}
        AND ts.reviewer_id = ${args.reviewerId}
        AND ts.view_revision = ${args.expectedRevision}
        AND ts.mode = 'untimed'::test_session_mode
        AND ts.expires_at IS NULL
        AND ts.status = 'active'::test_session_status
        AND ts.item_ids @> CAST(${JSON.stringify([args.itemId])} AS jsonb)
      FOR UPDATE
    ),
    existing_attempt AS MATERIALIZED (
      SELECT a.selected_answer, a.correct
      FROM test_attempts AS a
      WHERE a.session_id = ${args.sessionId}
        AND a.item_id = ${args.itemId}
      LIMIT 1
    ),
    current_view AS MATERIALIZED (
      SELECT v.revision
      FROM views AS v
      WHERE v.reviewer_id = ${args.reviewerId}
        AND v.kind = 'test_me'::view_kind
        AND v.revision = ${args.expectedRevision}
      FOR UPDATE
    ),
    written AS (
      INSERT INTO test_attempts (
        user_id,
        reviewer_id,
        session_id,
        view_revision,
        item_id,
        selected_answer,
        correct
      )
      SELECT
        ${args.userId},
        ${args.reviewerId},
        locked_session.id,
        current_view.revision,
        ${args.itemId},
        ${args.selectedAnswer},
        ${correct}
      FROM locked_session
      CROSS JOIN current_view
      ON CONFLICT (session_id, item_id)
        WHERE session_id IS NOT NULL
      DO UPDATE SET
        selected_answer = test_attempts.selected_answer,
        correct = test_attempts.correct,
        attempted_at = test_attempts.attempted_at
      RETURNING
        id,
        selected_answer,
        correct,
        (xmax = 0) AS inserted
    ),
    progressed AS (
      UPDATE test_sessions AS ts
      SET answered_count = ts.answered_count + 1,
          status = CASE
            WHEN ts.answered_count + 1 >= COALESCE(jsonb_array_length(ts.item_ids), 0)
              THEN 'completed'::test_session_status
            ELSE 'active'::test_session_status
          END,
          completed_at = CASE
            WHEN ts.answered_count + 1 >= COALESCE(jsonb_array_length(ts.item_ids), 0)
              THEN NOW()
            ELSE ts.completed_at
          END,
          updated_at = NOW()
      WHERE ts.id = ${args.sessionId}
        AND ts.status = 'active'::test_session_status
        AND EXISTS (SELECT 1 FROM written AS w WHERE w.inserted)
      RETURNING status, answered_count, completed_at
    )
    SELECT
      CASE
        WHEN EXISTS (SELECT 1 FROM written)
          THEN 'written'
        WHEN EXISTS (
          SELECT 1 FROM test_sessions AS ts
          WHERE ts.id = ${args.sessionId}
            AND ts.user_id = ${args.userId}
            AND ts.reviewer_id = ${args.reviewerId}
            AND ts.mode = 'untimed'::test_session_mode
            AND ts.view_revision <> ${args.expectedRevision}
        ) THEN 'stale'
        WHEN EXISTS (
          SELECT 1 FROM test_sessions AS ts
          WHERE ts.id = ${args.sessionId}
            AND ts.user_id = ${args.userId}
            AND ts.reviewer_id = ${args.reviewerId}
            AND ts.mode = 'untimed'::test_session_mode
            AND ts.view_revision = ${args.expectedRevision}
            AND NOT (ts.item_ids @> CAST(${JSON.stringify([args.itemId])} AS jsonb))
        ) THEN 'invalid'
        WHEN EXISTS (
          SELECT 1 FROM test_sessions AS ts
          WHERE ts.id = ${args.sessionId}
            AND ts.user_id = ${args.userId}
            AND ts.reviewer_id = ${args.reviewerId}
            AND ts.status = 'completed'::test_session_status
        ) THEN 'completed'
        WHEN EXISTS (SELECT 1 FROM locked_session)
          THEN 'stale'
        ELSE 'missing'
      END AS outcome,
      COALESCE(
        (SELECT w.selected_answer FROM written AS w LIMIT 1),
        (SELECT a.selected_answer FROM existing_attempt AS a LIMIT 1)
      ) AS selected_answer,
      COALESCE(
        (SELECT w.correct FROM written AS w LIMIT 1),
        (SELECT a.correct FROM existing_attempt AS a LIMIT 1)
      ) AS correct,
      COALESCE((SELECT w.inserted FROM written AS w LIMIT 1), FALSE) AS inserted,
      EXISTS (
        SELECT 1
        FROM progressed AS p
        WHERE p.status = 'completed'::test_session_status
      ) AS completed
  `);
  const row = result.rows[0] as
    | {
      outcome?: string;
      selected_answer?: string;
      correct?: boolean;
      inserted?: boolean;
      completed?: boolean;
    }
    | undefined;

  async function reread(): Promise<UntimedTestAttemptResult> {
    const [currentSession] = await db
      .select({
        status: testSessions.status,
        viewRevision: testSessions.viewRevision,
        itemIds: testSessions.itemIds,
      })
      .from(testSessions)
      .where(
        and(
          eq(testSessions.id, args.sessionId),
          eq(testSessions.userId, args.userId),
          eq(testSessions.reviewerId, args.reviewerId),
          eq(testSessions.mode, "untimed"),
        ),
      )
      .limit(1);
    const [existing] = await db
      .select({
        selectedAnswer: testAttempts.selectedAnswer,
        correct: testAttempts.correct,
      })
      .from(testAttempts)
      .where(
        and(
          eq(testAttempts.sessionId, args.sessionId),
          eq(testAttempts.itemId, args.itemId),
        ),
      )
      .limit(1);
    const decision = resolveUntimedAttemptReread({
      session: currentSession
        ? {
          status: currentSession.status,
          viewRevision: currentSession.viewRevision,
          itemIds: asItemIds(currentSession.itemIds),
        }
        : null,
      existing: existing ? { selectedAnswer: existing.selectedAnswer } : null,
      expectedRevision: args.expectedRevision,
      itemId: args.itemId,
      submitted: args.selectedAnswer,
    });
    if (decision === "missing") return { missing: true };
    if (decision === "stale") return { stale: true };
    if (decision === "invalid") return { invalid: true };
    if (decision === "conflict" || !existing) return { conflict: true };
    return {
      stats: await listTestAttemptStats(args.reviewerId, args.userId),
      alreadySaved: true,
      completed: currentSession?.status === "completed",
      answer: { itemId: args.itemId, selectedAnswer: existing.selectedAnswer, correct: existing.correct },
    };
  }

  if (row?.outcome === "invalid") return { invalid: true };
  // Keep a superseded sitting as stale. The follow-up read reports missing
  // when the stored revision still matches the caller and no answer row exists.
  if (row?.outcome === "stale") return { stale: true };
  if (row?.outcome !== "written" || typeof row.selected_answer !== "string") {
    return reread();
  }
  if (row.selected_answer !== args.selectedAnswer) return { conflict: true };
  let completed = row.completed === true;
  if (!completed) {
    const [currentSession] = await db
      .select({ status: testSessions.status })
      .from(testSessions)
      .where(
        and(
          eq(testSessions.id, args.sessionId),
          eq(testSessions.userId, args.userId),
          eq(testSessions.reviewerId, args.reviewerId),
        ),
      )
      .limit(1);
    completed = currentSession?.status === "completed";
  }
  return {
    stats: await listTestAttemptStats(args.reviewerId, args.userId),
    alreadySaved: row.inserted !== true,
    completed,
    answer: {
      itemId: args.itemId,
      selectedAnswer: row.selected_answer,
      correct: row.correct === true,
    },
  };
}

export async function updateStudyView(args: {
  reviewerId: string;
  userId: string;
  kind: "locked_in" | "summary" | "test_me" | "carded";
  expectedRevision: number;
  content?: string;
  pinned?: boolean;
}) {
  const reviewer = await getReviewer(args.reviewerId, args.userId);
  if (!reviewer) return null;
  if (args.content !== undefined) {
    const normalizedContent = normalizeDocumentText(args.content);
    const current = await getViewForReviewer(args.reviewerId, args.userId, args.kind);
    if (!current || current.revision !== args.expectedRevision) return { stale: true as const };
    const activeAnnotations = args.kind === "locked_in" || args.kind === "summary"
      ? await listAnnotationsForReviewer(args.reviewerId, args.userId, args.kind, { activeOnly: true })
      : [];
    const nextContentRevision = current.contentRevision + 1;
    const remapModel = renderedStudyTextModel(normalizedContent);
    const initialMappings: Array<({ mapped: true } & RemappedAnnotation) | { id: string; mapped: false }> = activeAnnotations.map((annotation) => {
      const mapped = remapAnnotation(annotation, normalizedContent, nextContentRevision, remapModel);
      return mapped
        ? { mapped: true as const, ...mapped }
        : { id: annotation.id, mapped: false as const };
    });
    const acceptedMappedIds = new Set(
      selectRenderableAnnotations(
        initialMappings
          .filter((mapping): mapping is ({ mapped: true } & RemappedAnnotation) => mapping.mapped)
          .map((mapping) => ({ ...mapping, archivedAt: null })),
      ).map((mapping) => mapping.id),
    );
    const annotationMappings = initialMappings.map((mapping) =>
      mapping.mapped && !acceptedMappedIds.has(mapping.id)
        ? { id: mapping.id, mapped: false }
        : mapping,
    );
    const result = await db.execute(sql`
      WITH target AS MATERIALIZED (
        SELECT v.id,
          v.revision,
          v.content_revision,
          v.annotation_revision
        FROM views v
        INNER JOIN reviewers r ON r.id = v.reviewer_id
        INNER JOIN topics t ON t.id = r.topic_id
        WHERE v.reviewer_id = ${args.reviewerId}
          AND t.user_id = ${args.userId}
          AND v.kind = ${args.kind}::view_kind
          AND v.revision = ${args.expectedRevision}
        FOR UPDATE OF v
      ), updated_view AS (
        UPDATE views v
        SET content = ${normalizedContent},
            revision = v.revision + 1,
            content_revision = v.content_revision + 1,
            annotation_revision = v.annotation_revision + 1,
            is_edited = TRUE,
            updated_at = NOW()
        FROM target
        WHERE v.id = target.id
        RETURNING v.id, v.content_revision
      ), input_mappings AS (
        SELECT item.id,
          item.mapped,
          item.start_offset,
          item.end_offset,
          item.quote,
          item.prefix,
          item.suffix,
          item.content_revision
        FROM jsonb_to_recordset(CAST(${JSON.stringify(annotationRemapRows(annotationMappings))} AS jsonb))
          AS item(
            id uuid,
            mapped boolean,
            start_offset integer,
            end_offset integer,
            quote text,
            prefix text,
            suffix text,
            content_revision integer
          )
      ), updated_annotations AS (
        UPDATE study_annotations a
        SET content_revision = CASE WHEN m.mapped THEN m.content_revision ELSE a.content_revision END,
            start_offset = CASE WHEN m.mapped THEN m.start_offset ELSE a.start_offset END,
            end_offset = CASE WHEN m.mapped THEN m.end_offset ELSE a.end_offset END,
            quote = CASE WHEN m.mapped THEN m.quote ELSE a.quote END,
            prefix = CASE WHEN m.mapped THEN m.prefix ELSE a.prefix END,
            suffix = CASE WHEN m.mapped THEN m.suffix ELSE a.suffix END,
            archived_at = CASE WHEN m.mapped THEN NULL ELSE NOW() END,
            archive_reason = CASE WHEN m.mapped THEN NULL ELSE 'content_changed' END,
            updated_at = NOW()
        FROM input_mappings m
        CROSS JOIN updated_view
        WHERE a.id = m.id
          AND a.view_id = updated_view.id
        RETURNING a.id
      )
      SELECT updated_view.id, updated_view.content_revision
      FROM updated_view
    `);
    if (result.rows.length === 0) return { stale: true as const };
    return getLatestView(args.reviewerId, args.kind);
  }
  const [row] = await db
    .update(views)
    .set({
      ...(args.content === undefined ? {} : { content: args.content, isEdited: true }),
      ...(args.pinned === undefined ? {} : { isPinned: args.pinned }),
      revision: sql<number>`${views.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(views.reviewerId, args.reviewerId),
        eq(views.kind, args.kind),
        eq(views.revision, args.expectedRevision),
      ),
    )
    .returning();
  return row ?? { stale: true as const };
}

function durableCard(row: Card): DurableCard {
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    front: row.front,
    back: row.back,
    kind: isClozeCardFront(row.front) ? "cloze" : "basic",
    revision: row.revision,
    isEdited: row.isEdited,
    isPinned: row.isPinned,
    dueAt: row.dueAt,
    intervalDays: row.intervalDays,
    repetitions: row.repetitions,
    easeFactor: row.easeFactor,
    lastReviewedAt: row.lastReviewedAt,
  };
}

function normalizeReviewedCard(row: unknown, base: Card): Card {
  const raw = row && typeof row === "object"
    ? row as Record<string, unknown>
    : {};
  const asDate = (value: unknown, fallback: Date | null): Date | null => {
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return fallback;
  };
  return {
    ...base,
    ...raw,
    dueAt: asDate(raw.dueAt, base.dueAt) ?? base.dueAt,
    lastReviewedAt: asDate(raw.lastReviewedAt, base.lastReviewedAt),
  } as Card;
}

export function serializeCard(row: Card) {
  return {
    ...durableCard(row),
    dueAt: row.dueAt.toISOString(),
    lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null,
  };
}

export async function getCardsForReviewer(
  reviewerId: string,
  userId: string,
): Promise<Card[]> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  let rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.reviewerId, reviewerId), isNull(cards.archivedAt)))
    .orderBy(asc(cards.dueAt), asc(cards.createdAt));
  if (rows.length > 0) return rows;

  const view = await getLatestView(reviewerId, "carded");
  const items = view ? parseCardedItems(view.contentJson, view.content) : [];
  const uniqueItems = items.filter(
    (item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index,
  );
  if (uniqueItems.length === 0) return [];
  await db
    .insert(cards)
    .values(
      uniqueItems.map((item) => ({
        reviewerId,
        sourceKey: item.id,
        front: item.front,
        back: item.back,
        originGenerationRunId: view?.generationRunId ?? null,
      })),
    )
    .onConflictDoNothing({ target: [cards.reviewerId, cards.sourceKey] });
  rows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.reviewerId, reviewerId), isNull(cards.archivedAt)))
    .orderBy(asc(cards.dueAt), asc(cards.createdAt));
  return rows;
}

export async function updateCard(args: {
  reviewerId: string;
  userId: string;
  cardId: string;
  expectedRevision: number;
  front?: string;
  back?: string;
  pinned?: boolean;
}) {
  const reviewer = await getReviewer(args.reviewerId, args.userId);
  if (!reviewer) return null;
  if (args.front !== undefined && !isValidCardFront(args.front)) {
    throw new Error("Invalid cloze card front");
  }
  const [row] = await db
    .update(cards)
    .set({
      ...(args.front === undefined ? {} : { front: args.front, isEdited: true }),
      ...(args.back === undefined ? {} : { back: args.back, isEdited: true }),
      ...(args.pinned === undefined ? {} : { isPinned: args.pinned }),
      revision: sql<number>`${cards.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(cards.id, args.cardId),
        eq(cards.reviewerId, args.reviewerId),
        eq(cards.revision, args.expectedRevision),
      ),
    )
    .returning();
  return row ?? { stale: true as const };
}

export async function syncGeneratedCards(args: {
  jobId: string;
  claimToken: string;
  reviewerId: string;
  userId: string;
  items: Array<{ id: string; front: string; back: string }>;
  generationRunId: string;
}): Promise<boolean> {
  if (args.items.length === 0 || args.items.length > MAX_CARDED_ITEMS) {
    throw new Error("Generated card output must contain 1 to 100 items");
  }
  // Generation schemas reject malformed IDs, but this is also a persistence
  // boundary. Normalize here so a future caller cannot create blank or
  // duplicate source keys that break durable card identity.
  if (
    args.items.some(
      (item) =>
        item.id.trim().length < 1 ||
        item.id.length > MAX_LEARNING_ID_CHARS ||
        !item.front.trim() ||
        !item.back.trim() ||
        item.front.length > MAX_CARD_FRONT_CHARS ||
        item.back.length > MAX_CARD_BACK_CHARS ||
        !isValidCardFront(item.front),
    )
  ) {
    throw new Error("Invalid generated card content");
  }
  const uniqueItems = normalizeLearningIds(args.items);
  const generatedJson = JSON.stringify(uniqueItems);
  if (generatedJson.length > MAX_GENERATED_JSON_CHARS) {
    throw new Error("Generated card output exceeds the safe size limit");
  }
  const applied = await db.execute(sql`
    WITH claimed AS MATERIALIZED (
      SELECT
        g.id,
        g.reviewer_id,
        g.user_id,
        g.generation_run_id,
        g.intent,
        g.force_overwrite,
        g.expected_protected
      FROM generation_jobs AS g
      WHERE g.id = ${args.jobId}
        AND g.reviewer_id = ${args.reviewerId}
        AND g.user_id = ${args.userId}
        AND g.generation_run_id = ${args.generationRunId}
        AND g.step = 'carded'::generation_job_step
        AND g.status IN ('queued', 'running')
        AND g.active = TRUE
        AND g.claim_token = ${args.claimToken}
        AND g.claim_expires_at > NOW()
      FOR UPDATE
    ), input AS (
      SELECT item.id, item.front, item.back
      FROM jsonb_to_recordset(CAST(${generatedJson} AS jsonb))
        AS item(id text, front text, back text)
    ), locked_cards AS MATERIALIZED (
      SELECT c.id, c.source_key, c.front, c.back, c.origin_generation_run_id,
        c.revision, c.is_edited, c.is_pinned, c.archived_at
      FROM cards c
      INNER JOIN claimed g ON g.reviewer_id = c.reviewer_id
      FOR UPDATE
    ), current_protected AS (
      SELECT CONCAT('card:', c.source_key) AS key, c.revision
      FROM locked_cards c
      WHERE c.archived_at IS NULL
        AND (c.is_edited OR c.is_pinned)
    ), expected_protected AS (
      SELECT entry.key, entry.revision
      FROM claimed g
      CROSS JOIN LATERAL jsonb_to_recordset(
        COALESCE(g.expected_protected, '[]'::jsonb)
      )
        AS entry(key text, revision integer)
      WHERE entry.key LIKE 'card:%'
    ), protection_valid AS (
      SELECT 1 AS ok
      FROM claimed
      WHERE (
        NOT claimed.force_overwrite
        OR (
          NOT EXISTS (
            SELECT 1
            FROM current_protected current_row
            WHERE NOT EXISTS (
              SELECT 1
              FROM expected_protected expected_row
              WHERE expected_row.key = current_row.key
                AND expected_row.revision = current_row.revision
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM expected_protected expected_row
            WHERE NOT EXISTS (
              SELECT 1
              FROM current_protected current_row
              WHERE current_row.key = expected_row.key
                AND current_row.revision = expected_row.revision
            )
          )
        )
      )
    ), valid AS (
      SELECT 1 AS ok
      FROM claimed
      CROSS JOIN protection_valid
      WHERE (
        claimed.force_overwrite
        OR NOT EXISTS (
          SELECT 1
          FROM locked_cards protected_card
          INNER JOIN input ON input.id = protected_card.source_key
          WHERE protected_card.archived_at IS NULL
            AND (protected_card.is_edited OR protected_card.is_pinned)
        )
      )
      AND (
        claimed.intent <> 'generate_missing'::generation_job_intent
        OR NOT EXISTS (
          SELECT 1
          FROM locked_cards existing_card
          INNER JOIN input ON input.id = existing_card.source_key
        )
      )
    ), already_persisted AS (
      SELECT 1 AS ok
      FROM claimed
      CROSS JOIN protection_valid
      WHERE NOT EXISTS (
          SELECT 1
          FROM input
          LEFT JOIN locked_cards existing_card
            ON existing_card.source_key = input.id
          WHERE existing_card.id IS NULL
             OR existing_card.archived_at IS NOT NULL
             OR existing_card.front <> input.front
             OR existing_card.back <> input.back
             OR existing_card.origin_generation_run_id IS DISTINCT FROM claimed.generation_run_id
             OR (NOT claimed.force_overwrite AND (existing_card.is_edited OR existing_card.is_pinned))
        )
        AND NOT EXISTS (
          SELECT 1
          FROM locked_cards extra_card
          WHERE extra_card.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM input WHERE input.id = extra_card.source_key)
            AND (claimed.force_overwrite OR (NOT extra_card.is_edited AND NOT extra_card.is_pinned))
        )
    ), upserted AS (
      INSERT INTO cards (
        reviewer_id,
        source_key,
        front,
        back,
        archived_at,
        origin_generation_run_id
      )
      SELECT
        ${args.reviewerId},
        input.id,
        input.front,
        input.back,
        NULL,
        (SELECT generation_run_id FROM claimed)
      FROM input
      CROSS JOIN valid
      ON CONFLICT (reviewer_id, source_key) DO UPDATE SET
        front = EXCLUDED.front,
        back = EXCLUDED.back,
        archived_at = NULL,
        origin_generation_run_id = EXCLUDED.origin_generation_run_id,
        is_edited = CASE WHEN (SELECT force_overwrite FROM claimed) THEN FALSE ELSE cards.is_edited END,
        is_pinned = CASE WHEN (SELECT force_overwrite FROM claimed) THEN FALSE ELSE cards.is_pinned END,
        revision = cards.revision + 1,
        updated_at = NOW()
      WHERE (SELECT intent FROM claimed) <> 'generate_missing'::generation_job_intent
        AND NOT EXISTS (SELECT 1 FROM already_persisted)
        AND ((SELECT force_overwrite FROM claimed)
          OR (cards.is_edited = FALSE AND cards.is_pinned = FALSE))
      RETURNING id
    ), archived AS (
      UPDATE cards c
      SET archived_at = NOW(), updated_at = NOW()
      FROM valid
      WHERE c.reviewer_id = ${args.reviewerId}
        AND NOT EXISTS (SELECT 1 FROM input WHERE input.id = c.source_key)
        AND (SELECT intent FROM claimed) <> 'generate_missing'::generation_job_intent
        AND NOT EXISTS (SELECT 1 FROM already_persisted)
        AND ((SELECT force_overwrite FROM claimed)
          OR (c.is_edited = FALSE AND c.is_pinned = FALSE))
      RETURNING c.id
    )
    SELECT ok
    FROM valid
    WHERE (SELECT intent FROM claimed) <> 'generate_missing'::generation_job_intent
       OR (SELECT COUNT(*) FROM upserted) = (SELECT COUNT(*) FROM input)
    UNION ALL
    SELECT ok
    FROM already_persisted
  `);
  return applied.rows.length > 0;
}

export async function listTestAttemptStats(
  reviewerId: string,
  userId: string,
): Promise<TestAttemptStats[]> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  const rows = await db
    .select()
    .from(testAttempts)
    .where(and(eq(testAttempts.reviewerId, reviewerId), eq(testAttempts.userId, userId)))
    .orderBy(desc(testAttempts.attemptedAt));
  const byItem = new Map<string, TestAttemptStats>();
  for (const row of rows) {
    const stats = byItem.get(row.itemId) ?? {
      itemId: row.itemId,
      attempts: 0,
      misses: 0,
      lastAttemptedAt: row.attemptedAt,
    };
    stats.attempts += 1;
    if (!row.correct) stats.misses += 1;
    byItem.set(row.itemId, stats);
  }
  return [...byItem.values()];
}

export async function recordTestAttempts(args: {
  reviewerId: string;
  userId: string;
  expectedRevision: number;
  answers: Array<{ itemId: string; selectedAnswer: string }>;
}) {
  if (
    args.answers.length < 1 ||
    args.answers.length > MAX_TEST_ATTEMPT_ITEMS ||
    args.answers.some(
      (answer) =>
        answer.itemId.length > 200 ||
        answer.selectedAnswer.length > MAX_TEST_ATTEMPT_SELECTED_ANSWER_CHARS,
    )
  ) {
    throw new Error("Test attempt payload exceeds the safe limit");
  }
  const view = await getViewForReviewer(args.reviewerId, args.userId, "test_me");
  if (!view) return { missing: true as const };
  if (view.revision !== args.expectedRevision) return { stale: true as const };
  const items = parseTestMeItems(view.contentJson, view.content);
  const byId = new Map(items.map((item) => [item.id, item]));
  const rows = args.answers.map((answer) => {
    const item = byId.get(answer.itemId);
    if (!item) throw new Error("Unknown test item");
    return {
      user_id: args.userId,
      reviewer_id: args.reviewerId,
      view_revision: view.revision,
      item_id: item.id,
      selected_answer: answer.selectedAnswer,
      correct: answer.selectedAnswer.trim().toLowerCase() === item.answer.trim().toLowerCase(),
    };
  });
  if (JSON.stringify(rows).length > MAX_GENERATED_JSON_CHARS) {
    throw new Error("Test attempt payload exceeds the safe size limit");
  }
  const inserted = await db.execute(sql`
    WITH current_view AS MATERIALIZED (
      SELECT revision
      FROM views
      WHERE reviewer_id = ${args.reviewerId}
        AND kind = 'test_me'::view_kind
        AND revision = ${args.expectedRevision}
      FOR UPDATE
    ), inserted AS (
      INSERT INTO test_attempts (
        user_id,
        reviewer_id,
        view_revision,
        item_id,
        selected_answer,
        correct
      )
      SELECT
        ${args.userId},
        ${args.reviewerId},
        current_view.revision,
        answer.item_id,
        answer.selected_answer,
        answer.correct
      FROM current_view
      CROSS JOIN jsonb_to_recordset(CAST(${JSON.stringify(rows)} AS jsonb))
        AS answer(item_id text, selected_answer text, correct boolean)
      RETURNING id
    )
    SELECT id FROM inserted
  `);
  if (inserted.rows.length !== rows.length) return { stale: true as const };
  return { stats: await listTestAttemptStats(args.reviewerId, args.userId) };
}

export async function reviewCard(args: {
  reviewerId: string;
  userId: string;
  cardId: string;
  expectedRevision: number;
  rating: CardRating;
  clientRequestId?: string;
}) {
  const reviewer = await getReviewer(args.reviewerId, args.userId);
  if (!reviewer) return null;
  const [current] = await db
    .select()
    .from(cards)
    .where(and(eq(cards.id, args.cardId), eq(cards.reviewerId, args.reviewerId)))
    .limit(1);
  if (!current) return null;
  if (!args.clientRequestId && current.revision !== args.expectedRevision) {
    return { stale: true as const };
  }
  const next = scheduleCardReview(
    {
      dueAt: current.dueAt,
      intervalDays: current.intervalDays,
      repetitions: current.repetitions,
      easeFactor: current.easeFactor,
    },
    args.rating,
    new Date(),
    reviewer.examDate,
  );
  const reviewedAt = new Date();
  const requestId = args.clientRequestId ?? null;
  const returningCard = sql`
        id,
        reviewer_id AS "reviewerId",
        source_key AS "sourceKey",
        front,
        back,
        revision,
        is_edited AS "isEdited",
        is_pinned AS "isPinned",
        due_at AS "dueAt",
        interval_days AS "intervalDays",
        repetitions,
        ease_factor AS "easeFactor",
        last_reviewed_at AS "lastReviewedAt"
  `;
  if (!requestId) {
    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE cards
        SET due_at = ${next.dueAt},
            interval_days = ${next.intervalDays},
            repetitions = ${next.repetitions},
            ease_factor = ${next.easeFactor},
            last_reviewed_at = ${reviewedAt},
            revision = revision + 1,
            updated_at = ${reviewedAt}
        WHERE id = ${args.cardId}
          AND reviewer_id = ${args.reviewerId}
          AND revision = ${args.expectedRevision}
        RETURNING ${returningCard}
      ), inserted AS (
        INSERT INTO card_reviews (
          user_id,
          reviewer_id,
          card_id,
          rating,
          due_at,
          interval_days,
          repetitions,
          ease_factor,
          reviewed_at
        )
        SELECT
          ${args.userId},
          ${args.reviewerId},
          updated.id,
          ${args.rating}::card_rating,
          updated."dueAt",
          updated."intervalDays",
          updated.repetitions,
          updated."easeFactor",
          ${reviewedAt}
        FROM updated
        RETURNING card_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN inserted ON inserted.card_id = updated.id
    `);
    const [updated] = result.rows;
    if (!updated) return { stale: true as const };
    return normalizeReviewedCard(updated, current);
  }
  const result = await db.execute(sql`
    WITH existing_request AS MATERIALIZED (
      SELECT cr.card_id
      FROM card_reviews AS cr
      WHERE cr.card_id = ${args.cardId}
        AND cr.user_id = ${args.userId}
        AND cr.client_request_id = ${requestId}
      LIMIT 1
    ),
    updated AS (
      UPDATE cards
      SET due_at = ${next.dueAt},
          interval_days = ${next.intervalDays},
          repetitions = ${next.repetitions},
          ease_factor = ${next.easeFactor},
          last_reviewed_at = ${reviewedAt},
          revision = revision + 1,
          updated_at = ${reviewedAt}
      WHERE id = ${args.cardId}
        AND reviewer_id = ${args.reviewerId}
        AND revision = ${args.expectedRevision}
        AND NOT EXISTS (SELECT 1 FROM existing_request)
      RETURNING ${returningCard}
    ), inserted AS (
      INSERT INTO card_reviews (
        user_id,
        reviewer_id,
        card_id,
        rating,
        client_request_id,
        due_at,
        interval_days,
        repetitions,
        ease_factor,
        reviewed_at
      )
      SELECT
        ${args.userId},
        ${args.reviewerId},
        updated.id,
        ${args.rating}::card_rating,
        ${requestId},
        updated."dueAt",
        updated."intervalDays",
        updated.repetitions,
        updated."easeFactor",
        ${reviewedAt}
      FROM updated
      ON CONFLICT (card_id, client_request_id)
        WHERE client_request_id IS NOT NULL
      DO NOTHING
      RETURNING card_id
    )
    SELECT updated.*
    FROM updated
    INNER JOIN inserted ON inserted.card_id = updated.id
  `);
  const [updated] = result.rows;
  if (updated) return normalizeReviewedCard(updated, current);
  const [replay] = await db
    .select({ cardId: cardReviews.cardId })
    .from(cardReviews)
    .where(
      and(
        eq(cardReviews.cardId, args.cardId),
        eq(cardReviews.userId, args.userId),
        eq(cardReviews.clientRequestId, requestId),
      ),
    )
    .limit(1);
  if (replay) {
    const [latest] = await db
      .select()
      .from(cards)
      .where(and(eq(cards.id, args.cardId), eq(cards.reviewerId, args.reviewerId)))
      .limit(1);
    return latest ?? current;
  }
  return { stale: true as const };
}

export async function updateReviewerExamDate(
  reviewerId: string,
  userId: string,
  examDate: string | null,
) {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return null;
  const [row] = await db
    .update(reviewers)
    .set({ examDate })
    .where(eq(reviewers.id, reviewerId))
    .returning();
  return row ?? null;
}

export async function protectedContentForGeneration(
  reviewerId: string,
  userId: string,
  kind: "locked_in" | "summary" | "test_me" | "carded",
): Promise<Array<{ key: string; revision: number }>> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  const rows = await db
    .select({
      kind: views.kind,
      revision: views.revision,
      annotationRevision: views.annotationRevision,
      isEdited: views.isEdited,
      isPinned: views.isPinned,
    })
    .from(views)
    .where(eq(views.reviewerId, reviewerId));
  const kinds = kind === "locked_in" ? ["locked_in", "summary", "test_me", "carded"] : [kind];
  const protectedKinds: Array<{ key: string; revision: number }> = rows
    .filter((row) => kinds.includes(row.kind) && (row.isEdited || row.isPinned))
    .map((row) => ({ key: `view:${row.kind}`, revision: row.revision }));
  const annotationRows = await db
    .select({ kind: annotations.kind, revision: views.annotationRevision })
    .from(annotations)
    .innerJoin(views, eq(views.id, annotations.viewId))
    .where(
      and(
        eq(annotations.reviewerId, reviewerId),
        isNull(annotations.archivedAt),
      ),
    );
  const seenAnnotationKinds = new Set<string>();
  for (const row of annotationRows) {
    if (kinds.includes(row.kind) && !seenAnnotationKinds.has(row.kind)) {
      protectedKinds.push({ key: `annotations:${row.kind}`, revision: row.revision });
      seenAnnotationKinds.add(row.kind);
    }
  }
  if (kind === "locked_in" || kind === "carded") {
    const protectedCards = await db
      .select({ sourceKey: cards.sourceKey, revision: cards.revision })
      .from(cards)
      .where(
        and(
          eq(cards.reviewerId, reviewerId),
          or(eq(cards.isEdited, true), eq(cards.isPinned, true)),
          isNull(cards.archivedAt),
        ),
      );
    protectedKinds.push(
      ...protectedCards.map((card) => ({ key: `card:${card.sourceKey}`, revision: card.revision })),
    );
  }
  return protectedKinds;
}

export async function getSource(id: string, userId: string): Promise<Source | null> {
  const [row] = await db
    .select({
      id: sources.id,
      reviewerId: sources.reviewerId,
      filename: sources.filename,
      mime: sources.mime,
      kind: sources.kind,
      blobUrl: sources.blobUrl,
      blobPathname: sources.blobPathname,
      ingestStatus: sources.ingestStatus,
      extractedText: sources.extractedText,
      errorMessage: sources.errorMessage,
      deletingAt: sources.deletingAt,
      createdAt: sources.createdAt,
    })
    .from(sources)
    .innerJoin(reviewers, eq(sources.reviewerId, reviewers.id))
    .innerJoin(topics, eq(reviewers.topicId, topics.id))
    .where(and(eq(sources.id, id), eq(topics.userId, userId)))
    .limit(1);
  return row
    ? { ...row, errorMessage: publicSourceErrorMessage(row.errorMessage) }
    : null;
}

export async function getSourceForReviewer(
  reviewerId: string,
  sourceId: string,
  userId: string,
): Promise<Source | null> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return null;
  const [row] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.reviewerId, reviewerId)))
    .limit(1);
  return row ?? null;
}

export async function createSourceForOwner(
  userId: string,
  values: Omit<NewSource, "id" | "createdAt"> &
    Partial<Pick<NewSource, "id" | "createdAt">>,
  attemptToken?: string,
): Promise<Source> {
  const blobPathname = values.blobPathname ?? null;
  const result = await db.execute(sql`
    WITH eligible_reviewer AS MATERIALIZED (
      SELECT r.id
      FROM reviewers AS r
      INNER JOIN topics AS t ON t.id = r.topic_id
      WHERE r.id = ${values.reviewerId}
        AND t.user_id = ${userId}
        AND r.deleting_at IS NULL
        AND t.deleting_at IS NULL
      FOR UPDATE OF r, t
    ),
    existing_source AS MATERIALIZED (
      SELECT s.*
      FROM sources AS s
      INNER JOIN eligible_reviewer AS er ON er.id = s.reviewer_id
      WHERE s.blob_pathname = ${blobPathname}
        AND s.blob_pathname IS NOT NULL
      LIMIT 1
      FOR UPDATE
    ),
    inserted AS (
      INSERT INTO sources (
        reviewer_id,
        filename,
        mime,
        kind,
        blob_url,
        blob_pathname,
        ingest_status,
        extracted_text,
        error_message,
        created_at
      )
      SELECT
        ${values.reviewerId},
        ${values.filename},
        ${values.mime},
        ${values.kind}::source_kind,
        ${values.blobUrl ?? null},
        ${blobPathname},
        ${values.ingestStatus}::ingest_status,
        ${values.extractedText ?? null},
        ${values.errorMessage ?? null},
        ${values.createdAt ?? new Date()}
      FROM eligible_reviewer
      WHERE NOT EXISTS (SELECT 1 FROM existing_source)
        AND (
          ${blobPathname === null}
          OR EXISTS (
            SELECT 1
            FROM blob_reservations AS br
            WHERE br.pathname = ${blobPathname}
              AND br.user_id = ${userId}
              AND br.reviewer_id = ${values.reviewerId}
              AND br.attempt_token = ${attemptToken ?? null}
              AND br.state = 'reserved'::blob_reservation_state
              AND br.lease_expires_at > NOW()
          )
        )
      ON CONFLICT (blob_pathname) WHERE blob_pathname IS NOT NULL DO NOTHING
      RETURNING *
    ),
    chosen AS MATERIALIZED (
      SELECT * FROM inserted
      UNION ALL
      SELECT * FROM existing_source
      WHERE NOT EXISTS (SELECT 1 FROM inserted)
    ),
    touched_reservation AS (
      UPDATE blob_reservations AS br
      SET updated_at = NOW(),
          lease_expires_at = GREATEST(br.lease_expires_at, NOW() + INTERVAL '15 minutes')
      WHERE br.pathname = ${blobPathname}
        AND br.user_id = ${userId}
        AND br.reviewer_id = ${values.reviewerId}
        AND br.attempt_token = ${attemptToken ?? null}
        AND br.state = 'reserved'::blob_reservation_state
        AND EXISTS (SELECT 1 FROM chosen)
      RETURNING br.pathname
    )
    SELECT * FROM chosen
  `);
  const raw = result.rows[0] as Record<string, unknown> | undefined;
  if (!raw) {
    throw new PublicError("Reviewer is being deleted or Blob pathname is unavailable");
  }
  return sourceFromRawRow(raw);
}

function sourceFromRawRow(raw: Record<string, unknown>): Source {
  const asDate = (value: unknown): Date | null =>
    value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  const row = {
    id: String(raw.id),
    reviewerId: String(raw.reviewer_id),
    filename: String(raw.filename),
    mime: String(raw.mime),
    kind: raw.kind as Source["kind"],
    blobUrl: (raw.blob_url as string | null) ?? null,
    blobPathname: (raw.blob_pathname as string | null) ?? null,
    ingestStatus: raw.ingest_status as Source["ingestStatus"],
    extractedText: (raw.extracted_text as string | null) ?? null,
    errorMessage: (raw.error_message as string | null) ?? null,
    deletingAt: asDate(raw.deleting_at),
    createdAt: asDate(raw.created_at) ?? new Date(0),
  } satisfies Source;
  return { ...row, errorMessage: publicSourceErrorMessage(row.errorMessage) };
}

/** Delete a source and its cleanup reservation in one database statement. */
export async function deleteSourceForOwner(
  id: string,
  reviewerId: string,
  userId: string,
): Promise<Source | null> {
  const result = await db.execute(sql`
    WITH deleted AS (
      DELETE FROM sources AS s
      USING reviewers AS r, topics AS t
      WHERE s.id = ${id}
        AND s.reviewer_id = ${reviewerId}
        AND s.reviewer_id = r.id
        AND r.topic_id = t.id
        AND t.user_id = ${userId}
        AND s.deleting_at IS NOT NULL
      RETURNING s.*
    ),
    reservations_deleted AS (
      DELETE FROM blob_reservations AS br
      USING deleted AS d
      WHERE br.pathname = d.blob_pathname
        AND br.user_id = ${userId}
        AND br.reviewer_id = ${reviewerId}
      RETURNING br.pathname
    )
    SELECT * FROM deleted
  `);
  const raw = result.rows[0] as Record<string, unknown> | undefined;
  return raw ? sourceFromRawRow(raw) : null;
}

/** Claim one source for provider deletion while retaining a retryable row. */
export async function beginSourceDeletion(
  id: string,
  reviewerId: string,
  userId: string,
): Promise<Source | null> {
  const result = await db.execute(sql`
    UPDATE sources AS s
    SET deleting_at = COALESCE(s.deleting_at, NOW())
    FROM reviewers AS r, topics AS t
    WHERE s.id = ${id}
      AND s.reviewer_id = ${reviewerId}
      AND s.reviewer_id = r.id
      AND r.topic_id = t.id
      AND t.user_id = ${userId}
    RETURNING s.*
  `);
  const raw = result.rows[0] as Record<string, unknown> | undefined;
  return raw ? sourceFromRawRow(raw) : null;
}

export async function deleteSource(id: string): Promise<Source | null> {
  const [row] = await db
    .delete(sources)
    .where(eq(sources.id, id))
    .returning();
  return row ?? null;
}

export async function createGenerationJob(
  values: Omit<NewGenerationJob, "id" | "createdAt" | "updatedAt"> &
    Partial<Pick<NewGenerationJob, "id" | "createdAt" | "updatedAt">>,
): Promise<GenerationJob> {
  const now = values.updatedAt ?? new Date();
  const [row] = await db
    .insert(generationJobs)
    .values({ ...values, updatedAt: now })
    .returning();
  return row;
}

/** Return persisted mode presence for server-side missing-mode planning. */
export async function getGenerationExistingKinds(
  reviewerId: string,
  userId: string,
): Promise<Partial<Record<GenerateKind, boolean>>> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return {};
  const rows = await db
    .select({ kind: views.kind, content: views.content, contentJson: views.contentJson })
    .from(views)
    .where(eq(views.reviewerId, reviewerId));
  return Object.fromEntries(
    rows.map((row) => [
      row.kind,
      Boolean(row.content?.trim()) || (Array.isArray(row.contentJson) && row.contentJson.length > 0),
    ]),
  ) as Partial<Record<GenerateKind, boolean>>;
}

/** Snapshot revisions for dependencies that are not part of this run. */
export async function getGenerationUpstreamRevisions(
  reviewerId: string,
  userId: string,
  targetKinds: readonly GenerateKind[],
): Promise<Partial<Record<GenerateKind, number>>> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return {};
  const target = new Set(targetKinds);
  const upstreamKinds = new Set<GenerateKind>();
  for (const kind of targetKinds) {
    if (kind === "summary" || kind === "test_me") upstreamKinds.add("locked_in");
    if (kind === "carded") upstreamKinds.add("summary");
  }
  const rows = await db
    .select({ kind: views.kind, revision: views.revision })
    .from(views)
    .where(eq(views.reviewerId, reviewerId));
  return Object.fromEntries(
    rows
      .filter((row) => upstreamKinds.has(row.kind) && !target.has(row.kind))
      .map((row) => [row.kind, row.revision]),
  ) as Partial<Record<GenerateKind, number>>;
}

/**
 * Return the one resumable job for a reviewer. Terminal jobs are marked
 * inactive and remain available as history without blocking a new run.
 */
export async function getActiveGenerationJobForReviewer(
  reviewerId: string,
  userId: string,
): Promise<GenerationJob | null> {
  const [row] = await db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.reviewerId, reviewerId),
        eq(generationJobs.userId, userId),
        eq(generationJobs.active, true),
        or(
          eq(generationJobs.status, "queued"),
          eq(generationJobs.status, "running"),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Most recent run, including terminal partial/failed runs for view revisioning. */
export async function getLatestGenerationJobForReviewer(
  reviewerId: string,
  userId: string,
): Promise<GenerationJob | null> {
  const [row] = await db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.reviewerId, reviewerId),
        eq(generationJobs.userId, userId),
      ),
    )
    .orderBy(desc(generationJobs.createdAt), desc(generationJobs.updatedAt))
    .limit(1);
  return row ?? null;
}

/** Find the latest full-pack run used as the revision baseline for redo overlays. */
export async function getLatestFullGenerationJobForReviewer(
  reviewerId: string,
  userId: string,
): Promise<GenerationJob | null> {
  const [row] = await db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.reviewerId, reviewerId),
        eq(generationJobs.userId, userId),
        eq(generationJobs.mode, "full"),
      ),
    )
    .orderBy(desc(generationJobs.createdAt), desc(generationJobs.updatedAt))
    .limit(1);
  return row ?? null;
}

/** Reactivate a terminal run so Retry/Resume preserves its frozen scope. */
export async function reactivateGenerationJobForResume(args: {
  id: string;
  reviewerId: string;
  userId: string;
}): Promise<GenerationJob | null> {
  try {
    const [row] = await db
      .update(generationJobs)
      .set({
        status: "queued",
        active: true,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        claimToken: null,
        claimExpiresAt: null,
        claimedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(generationJobs.id, args.id),
          eq(generationJobs.reviewerId, args.reviewerId),
          eq(generationJobs.userId, args.userId),
          eq(generationJobs.active, false),
          sql`${generationJobs.step} IS NOT NULL`,
          or(eq(generationJobs.status, "partial"), eq(generationJobs.status, "failed")),
        ),
      )
      .returning();
    if (row) return row;

    // A concurrent request can win the same terminal-row update without
    // colliding with the active-job partial index. Re-read this exact row so
    // the caller adopts its now-active state instead of returning the stale
    // terminal snapshot it already had.
    const [current] = await db
      .select()
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.id, args.id),
          eq(generationJobs.reviewerId, args.reviewerId),
          eq(generationJobs.userId, args.userId),
        ),
      )
      .limit(1);
    return current?.active && (current.status === "queued" || current.status === "running")
      ? current
      : null;
  } catch (error) {
    // Another request may have created/reactivated the reviewer's one active
    // job between its read and this update. Reuse that winner rather than
    // leaking the partial-index 23505 as an HTTP 500.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505"
    ) {
      return getActiveGenerationJobForReviewer(args.reviewerId, args.userId);
    }
    throw error;
  }
}

/**
 * Create a job unless another request won the partial unique index race.
 * This keeps the initial POST idempotent under double-clicks and retries.
 */
export async function createOrReuseGenerationJob(
  values: Omit<NewGenerationJob, "id" | "createdAt" | "updatedAt"> &
    Partial<Pick<NewGenerationJob, "id" | "createdAt" | "updatedAt">>,
): Promise<{ job: GenerationJob; reused: boolean }> {
  const existing = await getActiveGenerationJobForReviewer(
    values.reviewerId,
    values.userId,
  );
  if (existing) return { job: existing, reused: true };

  try {
    return { job: await createGenerationJob(values), reused: false };
  } catch (error) {
    // A concurrent POST may have inserted the active row between the select
    // and insert. Re-read only after an insert error; preserve other errors.
    const concurrent = await getActiveGenerationJobForReviewer(
      values.reviewerId,
      values.userId,
    );
    if (concurrent) return { job: concurrent, reused: true };
    throw error;
  }
}

/**
 * Atomically claim exactly the job's current step. A claim with an expired
 * lease is eligible for recovery, so a browser refresh can resume safely.
 */
export async function claimGenerationJobStep(args: {
  id: string;
  reviewerId: string;
  userId: string;
  step: GenerationJobStep;
  claimToken: string;
  claimExpiresAt: Date;
}): Promise<GenerationJob | null> {
  const now = new Date();
  const [row] = await db
    .update(generationJobs)
    .set({
      status: "running",
      claimToken: args.claimToken,
      claimExpiresAt: args.claimExpiresAt,
      claimedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(generationJobs.id, args.id),
        eq(generationJobs.reviewerId, args.reviewerId),
        eq(generationJobs.userId, args.userId),
        eq(generationJobs.active, true),
        eq(generationJobs.step, args.step),
        // Legacy rows have an empty target list and are reconstructed by the
        // route; new rows must never claim a step outside their frozen scope.
        or(
          sql`${generationJobs.targetKinds} = '[]'::jsonb`,
          sql`${generationJobs.targetKinds} @> ${JSON.stringify([args.step])}::jsonb`,
        ),
        or(eq(generationJobs.status, "queued"), eq(generationJobs.status, "running")),
        or(isNull(generationJobs.claimExpiresAt), lt(generationJobs.claimExpiresAt, now)),
      ),
    )
    .returning();
  return row ?? null;
}

/** Update a claimed job only while that claim is still the owner. */
export async function updateClaimedGenerationJob(
  id: string,
  claimToken: string,
  patch: Partial<
    Pick<
      GenerationJob,
      | "status"
      | "step"
      | "completedKinds"
      | "upstreamRevisions"
      | "errorCode"
      | "errorMessage"
      | "modelUsed"
      | "finishedAt"
      | "active"
      | "claimToken"
      | "claimExpiresAt"
      | "claimedAt"
    >
  >,
): Promise<GenerationJob | null> {
  const [row] = await db
    .update(generationJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(generationJobs.id, id),
        eq(generationJobs.claimToken, claimToken),
        eq(generationJobs.active, true),
        gt(generationJobs.claimExpiresAt, new Date()),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Commit terminal success and the reviewer's generation timestamp together.
 * Neon's HTTP driver does not require an interactive transaction here: one
 * data-modifying statement makes the two writes an all-or-nothing boundary.
 */
export async function completeClaimedGenerationJob(args: {
  id: string;
  reviewerId: string;
  userId: string;
  claimToken: string;
  step: GenerationJobStep;
  completedKinds: GenerationJob["completedKinds"];
  upstreamRevisions: GenerationJob["upstreamRevisions"];
  modelUsed: string;
  finishedAt: Date;
}): Promise<GenerationJob | null> {
  const result = await db.execute(sql`
    WITH completed AS (
      UPDATE generation_jobs
      SET status = 'succeeded'::generation_job_status,
          step = ${args.step}::generation_job_step,
          completed_kinds = CAST(${JSON.stringify(args.completedKinds)} AS jsonb),
          upstream_revisions = CAST(${JSON.stringify(args.upstreamRevisions)} AS jsonb),
          model_used = ${args.modelUsed},
          error_code = NULL,
          error_message = NULL,
          active = FALSE,
          finished_at = ${args.finishedAt},
          claim_token = NULL,
          claim_expires_at = NULL,
          claimed_at = NULL,
          updated_at = NOW()
      WHERE id = ${args.id}
        AND reviewer_id = ${args.reviewerId}
        AND user_id = ${args.userId}
        AND status IN ('queued', 'running')
        AND active = TRUE
        AND claim_token = ${args.claimToken}
        AND claim_expires_at > NOW()
      RETURNING reviewer_id, finished_at
    ), reviewer_updated AS (
      UPDATE reviewers r
      SET last_generated_at = completed.finished_at
      FROM completed
      WHERE r.id = completed.reviewer_id
      RETURNING r.id
    )
    SELECT completed.reviewer_id
    FROM completed
    INNER JOIN reviewer_updated ON reviewer_updated.id = completed.reviewer_id
  `);
  if (result.rows.length === 0) return null;
  return getGenerationJobForReviewer(args.reviewerId, args.id, args.userId);
}

/**
 * Publish a generated view only if the exact live claim still belongs to this
 * worker. The CTE updates the claim and inserts the view in one SQL statement;
 * a recovered/expired worker receives false and cannot overwrite the newer
 * run's row.
 */
export async function persistViewForActiveClaim(args: {
  jobId: string;
  reviewerId: string;
  userId: string;
  claimToken: string;
  generationRunId: string;
  step: GenerationJobStep;
  content: string;
  contentJson: unknown | null;
  modelUsed: string;
  generatedAt: Date;
  forceOverwrite: boolean;
  cardItems?: Array<{ id: string; front: string; back: string }>;
}): Promise<number | null> {
  if (args.content.length > MAX_GENERATED_MARKDOWN_CHARS) {
    throw new Error("Generated text exceeds the safe output limit");
  }
  if (args.step === "test_me" || args.step === "carded") {
    if (!Array.isArray(args.contentJson)) {
      throw new Error("Generated structured output is invalid");
    }
    const parsedItems = args.step === "test_me"
      ? parseTestMeItems(args.contentJson, args.content)
      : parseCardedItems(args.contentJson, args.content);
    if (parsedItems.length === 0) {
      throw new Error(`Generated ${args.step} output must contain at least one item`);
    }
    if (parsedItems.length !== args.contentJson.length) {
      throw new Error(`Generated ${args.step} output contains invalid items`);
    }
  }
  const contentJson =
    args.contentJson === null ? null : JSON.stringify(args.contentJson);
  if (contentJson && contentJson.length > MAX_GENERATED_JSON_CHARS) {
    throw new Error("Generated structured output exceeds the safe size limit");
  }
  const generatedCardItems = args.step === "carded"
    ? normalizeLearningIds(args.cardItems ?? [])
    : [];
  if (args.step === "carded" && (generatedCardItems.length === 0 || generatedCardItems.length > MAX_CARDED_ITEMS)) {
    throw new Error("Generated card output must contain 1 to 100 items");
  }
  if (generatedCardItems.some(
    (item) =>
      item.id.trim().length < 1 ||
      item.id.length > MAX_LEARNING_ID_CHARS ||
      !item.front.trim() ||
      !item.back.trim() ||
      item.front.length > MAX_CARD_FRONT_CHARS ||
      item.back.length > MAX_CARD_BACK_CHARS ||
      !isValidCardFront(item.front),
  )) {
    throw new Error("Invalid generated card content");
  }
  const generatedCardsJson = JSON.stringify(generatedCardItems);
  if (generatedCardsJson.length > MAX_GENERATED_JSON_CHARS) {
    throw new Error("Generated card output exceeds the safe size limit");
  }
  let result: { rows: Array<{ revision?: number }> };
  try {
    result = await db.execute(sql`
    WITH claimed AS (
      UPDATE generation_jobs
      SET model_used = ${args.modelUsed}, updated_at = NOW()
      WHERE id = ${args.jobId}
        AND reviewer_id = ${args.reviewerId}
        AND user_id = ${args.userId}
        AND generation_run_id = ${args.generationRunId}
        AND step = ${args.step}::generation_job_step
        AND status IN ('queued', 'running')
        AND active = TRUE
      AND claim_token = ${args.claimToken}
      AND claim_expires_at > NOW()
      RETURNING reviewer_id, generation_run_id, step, intent, force_overwrite, expected_protected, upstream_revisions
    ), input AS (
      SELECT item.id, item.front, item.back
      FROM jsonb_to_recordset(CAST(${generatedCardsJson} AS jsonb))
        AS item(id text, front text, back text)
    ), locked_views AS MATERIALIZED (
      SELECT v.id, v.kind, v.revision, v.content_revision, v.annotation_revision,
        v.is_edited, v.is_pinned
      FROM views v
      INNER JOIN claimed c ON c.reviewer_id = v.reviewer_id
      WHERE v.kind::text = c.step::text
      FOR UPDATE
    ), locked_cards AS MATERIALIZED (
      SELECT c2.id, c2.source_key, c2.revision, c2.is_edited, c2.is_pinned, c2.archived_at
      FROM cards c2
      INNER JOIN claimed c ON c.reviewer_id = c2.reviewer_id
      WHERE c.step = 'carded'::generation_job_step
      FOR UPDATE
    ), locked_upstream_views AS MATERIALIZED (
      SELECT upstream.kind::text AS kind, upstream.revision
      FROM views upstream
      INNER JOIN claimed c ON c.reviewer_id = upstream.reviewer_id
      CROSS JOIN LATERAL jsonb_each_text(
        COALESCE(c.upstream_revisions, '{}'::jsonb)
      ) AS expected(kind, revision)
      WHERE upstream.kind::text = expected.kind
      FOR UPDATE OF upstream
    ), current_protected AS (
      SELECT CONCAT('view:', v.kind::text) AS key, v.revision
      FROM locked_views v
      WHERE (v.is_edited OR v.is_pinned)
      UNION ALL
      SELECT CONCAT('annotations:', v.kind::text) AS key, v.annotation_revision
      FROM locked_views v
      WHERE EXISTS (
        SELECT 1
        FROM study_annotations a
        WHERE a.view_id = v.id
          AND a.archived_at IS NULL
      )
      UNION ALL
      SELECT CONCAT('card:', c2.source_key) AS key, c2.revision
      FROM locked_cards c2
      WHERE c2.archived_at IS NULL
        AND (c2.is_edited OR c2.is_pinned)
    ), expected_protected AS (
      SELECT entry.key, entry.revision
      FROM claimed c
      CROSS JOIN LATERAL jsonb_to_recordset(
        COALESCE(c.expected_protected, '[]'::jsonb)
      ) AS entry(key text, revision integer)
      WHERE entry.key = CONCAT('view:', c.step::text)
         OR entry.key = CONCAT('annotations:', c.step::text)
         OR (c.step = 'carded'::generation_job_step AND entry.key LIKE 'card:%')
    ), valid_claim AS (
      SELECT c.*
      FROM claimed c
      WHERE (
        NOT c.force_overwrite
        OR (
          NOT EXISTS (
            SELECT 1
            FROM current_protected current_row
            WHERE NOT EXISTS (
              SELECT 1
              FROM expected_protected expected_row
              WHERE expected_row.key = current_row.key
                AND expected_row.revision = current_row.revision
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM expected_protected expected_row
            WHERE NOT EXISTS (
              SELECT 1
              FROM current_protected current_row
              WHERE current_row.key = expected_row.key
                AND current_row.revision = expected_row.revision
            )
          )
        )
      )
      AND (c.force_overwrite OR NOT EXISTS (
        SELECT 1
        FROM locked_views protected_view
        WHERE protected_view.is_edited OR protected_view.is_pinned
      ))
      AND (
        c.intent <> 'generate_missing'::generation_job_intent
        OR NOT EXISTS (SELECT 1 FROM locked_views)
      )
      AND (
        c.step <> 'carded'::generation_job_step
        OR c.force_overwrite
        OR NOT EXISTS (
          SELECT 1
          FROM locked_cards protected_card
          INNER JOIN input ON input.id = protected_card.source_key
          WHERE protected_card.archived_at IS NULL
            AND (protected_card.is_edited OR protected_card.is_pinned)
        )
      )
      AND (
        c.intent <> 'generate_missing'::generation_job_intent
        OR NOT EXISTS (
          SELECT 1
          FROM locked_cards existing_card
          INNER JOIN input ON input.id = existing_card.source_key
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_each_text(COALESCE(c.upstream_revisions, '{}'::jsonb)) expected(kind, revision)
        LEFT JOIN locked_upstream_views upstream
          ON upstream.kind = expected.kind
        WHERE upstream.revision IS NULL
           OR upstream.revision <> expected.revision::integer
      )
      AND (
        SELECT COUNT(*) FROM locked_upstream_views
      ) = (
        SELECT COUNT(*)
        FROM claimed expected_claim
        CROSS JOIN LATERAL jsonb_object_keys(
          COALESCE(expected_claim.upstream_revisions, '{}'::jsonb)
        )
      )
    ), archived_annotations AS (
      UPDATE study_annotations a
      SET archived_at = ${args.generatedAt},
          archive_reason = 'generated_replacement',
          updated_at = ${args.generatedAt}
      FROM valid_claim valid
      INNER JOIN views target_view
        ON target_view.reviewer_id = valid.reviewer_id
       AND target_view.kind = valid.step::view_kind
      WHERE valid.intent <> 'generate_missing'::generation_job_intent
        AND a.view_id = target_view.id
        AND a.archived_at IS NULL
      RETURNING a.id
    ), archived_annotation_count AS (
      SELECT COUNT(*)::integer AS count
      FROM archived_annotations
    ), view_gate AS (
      INSERT INTO views (
        reviewer_id,
        kind,
        content,
        content_json,
        model_id,
        generation_run_id,
        generated_at,
        revision,
        is_edited,
        is_pinned,
        updated_at
      )
      SELECT
        valid.reviewer_id,
        valid.step::view_kind,
        ${args.content},
        CAST(${contentJson} AS jsonb),
        ${args.modelUsed},
        valid.generation_run_id,
        ${args.generatedAt},
        1,
        FALSE,
        FALSE,
        ${args.generatedAt}
      FROM valid_claim valid
      CROSS JOIN archived_annotation_count
      ON CONFLICT (reviewer_id, kind) DO UPDATE SET
        content = EXCLUDED.content,
        content_json = EXCLUDED.content_json,
        model_id = EXCLUDED.model_id,
        generation_run_id = EXCLUDED.generation_run_id,
        generated_at = EXCLUDED.generated_at,
        content_revision = views.content_revision + 1,
        annotation_revision = views.annotation_revision + 1,
        revision = views.revision + 1,
        is_edited = FALSE,
        is_pinned = FALSE,
        updated_at = EXCLUDED.updated_at
      WHERE (SELECT intent FROM valid_claim) <> 'generate_missing'::generation_job_intent
        AND ((SELECT force_overwrite FROM valid_claim)
          OR (views.is_edited = FALSE AND views.is_pinned = FALSE))
      RETURNING id, revision
    ), cards_upserted AS (
      INSERT INTO cards (
        reviewer_id,
        source_key,
        front,
        back,
        archived_at,
        origin_generation_run_id
      )
      SELECT
        valid.reviewer_id,
        input.id,
        input.front,
        input.back,
        NULL,
        valid.generation_run_id
      FROM valid_claim valid
      CROSS JOIN view_gate
      CROSS JOIN input
      WHERE valid.step = 'carded'::generation_job_step
      ON CONFLICT (reviewer_id, source_key) DO UPDATE SET
        front = EXCLUDED.front,
        back = EXCLUDED.back,
        archived_at = NULL,
        origin_generation_run_id = EXCLUDED.origin_generation_run_id,
        is_edited = CASE WHEN (SELECT force_overwrite FROM valid_claim) THEN FALSE ELSE cards.is_edited END,
        is_pinned = CASE WHEN (SELECT force_overwrite FROM valid_claim) THEN FALSE ELSE cards.is_pinned END,
        revision = cards.revision + 1,
        updated_at = NOW()
      WHERE (SELECT intent FROM valid_claim) <> 'generate_missing'::generation_job_intent
        AND ((SELECT force_overwrite FROM valid_claim)
          OR (cards.is_edited = FALSE AND cards.is_pinned = FALSE))
      RETURNING id
    ), archived_cards AS (
      UPDATE cards existing_card
      SET archived_at = NOW(), updated_at = NOW()
      FROM valid_claim valid
      CROSS JOIN view_gate
      WHERE valid.step = 'carded'::generation_job_step
        AND existing_card.reviewer_id = valid.reviewer_id
        AND NOT EXISTS (SELECT 1 FROM input WHERE input.id = existing_card.source_key)
        AND valid.intent <> 'generate_missing'::generation_job_intent
        AND (valid.force_overwrite OR (existing_card.is_edited = FALSE AND existing_card.is_pinned = FALSE))
      RETURNING existing_card.id
    ), card_write_guard AS (
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM view_gate)
          OR (SELECT step FROM valid_claim) <> 'carded'::generation_job_step
          OR (SELECT COUNT(*) FROM cards_upserted) = (SELECT COUNT(*) FROM input)
          THEN 1
        ELSE 1 / (
          SELECT COUNT(*)::integer - COUNT(*)::integer
          FROM input
        )
      END AS ok
    )
    SELECT revision
    FROM view_gate
    CROSS JOIN card_write_guard
    WHERE card_write_guard.ok = 1
    `);
  } catch (error) {
    // The Carded cardinality guard deliberately aborts the statement when a
    // concurrent insert makes the write set incomplete. Treat that rollback
    // as a stale claim instead of surfacing an opaque database error.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "22012"
    ) {
      return null;
    }
    throw error;
  }
  const row = result.rows[0] as { revision?: number } | undefined;
  return typeof row?.revision === "number" ? row.revision : null;
}

export async function updateGenerationJob(
  id: string,
  patch: Partial<
    Pick<
      GenerationJob,
      | "status"
      | "step"
      | "errorCode"
      | "errorMessage"
      | "modelUsed"
      | "finishedAt"
      | "active"
      | "claimToken"
      | "claimExpiresAt"
      | "claimedAt"
    >
  >,
): Promise<GenerationJob | null> {
  const [row] = await db
    .update(generationJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(generationJobs.id, id))
    .returning();
  return row ?? null;
}

export async function getViewForGeneration(
  reviewerId: string,
  kind: "locked_in" | "summary" | "test_me" | "carded",
  generationRunId: string,
) {
  const [row] = await db
    .select()
    .from(views)
    .where(
      and(
        eq(views.reviewerId, reviewerId),
        eq(views.kind, kind),
        eq(views.generationRunId, generationRunId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getLatestView(
  reviewerId: string,
  kind: "locked_in" | "summary" | "test_me" | "carded",
) {
  const [row] = await db
    .select()
    .from(views)
    .where(and(eq(views.reviewerId, reviewerId), eq(views.kind, kind)))
    .orderBy(desc(views.generatedAt))
    .limit(1);
  return row ?? null;
}

export async function getGenerationJobForReviewer(
  reviewerId: string,
  jobId: string,
  userId: string,
): Promise<GenerationJob | null> {
  const [row] = await db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.reviewerId, reviewerId),
        eq(generationJobs.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function isLoginEmailLocked(email: string): Promise<boolean> {
  const key = normalizeLoginEmail(email);
  const [row] = await db
    .select({ lockedUntil: loginThrottles.lockedUntil })
    .from(loginThrottles)
    .where(eq(loginThrottles.email, key))
    .limit(1);
  return row?.lockedUntil != null && row.lockedUntil.getTime() > Date.now();
}

export async function recordLoginFailure(
  email: string,
): Promise<{ locked: boolean }> {
  const key = normalizeLoginEmail(email);
  const result = await db.execute(sql`
    INSERT INTO login_throttles (email, failed_count, window_started_at, locked_until, updated_at)
    VALUES (${key}, 1, NOW(), NULL, NOW())
    ON CONFLICT (email) DO UPDATE SET
      failed_count = CASE
        WHEN login_throttles.locked_until IS NOT NULL
          AND login_throttles.locked_until > NOW()
          THEN login_throttles.failed_count
        WHEN login_throttles.locked_until IS NOT NULL
          AND login_throttles.locked_until <= NOW()
          THEN 1
        WHEN login_throttles.window_started_at <= NOW() - INTERVAL '15 minutes'
          THEN 1
        ELSE login_throttles.failed_count + 1
      END,
      window_started_at = CASE
        WHEN login_throttles.locked_until IS NOT NULL
          AND login_throttles.locked_until > NOW()
          THEN login_throttles.window_started_at
        WHEN login_throttles.locked_until IS NOT NULL
          AND login_throttles.locked_until <= NOW()
          THEN NOW()
        WHEN login_throttles.window_started_at <= NOW() - INTERVAL '15 minutes'
          THEN NOW()
        ELSE login_throttles.window_started_at
      END,
      locked_until = CASE
        WHEN login_throttles.locked_until IS NOT NULL
          AND login_throttles.locked_until > NOW()
          THEN login_throttles.locked_until
        WHEN login_throttles.locked_until IS NOT NULL
          AND login_throttles.locked_until <= NOW()
          THEN NULL
        WHEN login_throttles.window_started_at <= NOW() - INTERVAL '15 minutes'
          THEN NULL
        WHEN login_throttles.failed_count + 1 >= 5
          THEN NOW() + INTERVAL '15 minutes'
        ELSE NULL
      END,
      updated_at = NOW()
    RETURNING locked_until
  `);
  const lockedUntil = result.rows[0]?.locked_until;
  if (lockedUntil instanceof Date) {
    return { locked: lockedUntil.getTime() > Date.now() };
  }
  if (typeof lockedUntil === "string") {
    return { locked: Date.parse(lockedUntil) > Date.now() };
  }
  return { locked: false };
}

export async function clearLoginThrottle(email: string): Promise<void> {
  const key = normalizeLoginEmail(email);
  await db.delete(loginThrottles).where(eq(loginThrottles.email, key));
}

export async function getUserIdByEmail(email: string): Promise<string | null> {
  const key = normalizeLoginEmail(email);
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, key))
    .limit(1);
  return row?.id ?? null;
}

export async function getUserEmailById(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

export async function issuePasswordResetToken(
  email: string,
): Promise<string | null> {
  const userId = await getUserIdByEmail(email);
  if (!userId) return null;

  const token = createResetToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  await db.execute(sql`
    UPDATE password_reset_tokens
    SET consumed_at = NOW()
    WHERE user_id = ${userId}
      AND consumed_at IS NULL
  `);
  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash,
    expiresAt,
  });
  return token;
}

export async function peekPasswordResetToken(
  token: string,
): Promise<{ id: string; userId: string } | null> {
  if (!token.trim()) return null;
  const tokenHash = hashResetToken(token);
  const [row] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      consumedAt: passwordResetTokens.consumedAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return { id: row.id, userId: row.userId };
}

export async function consumePasswordResetAndSetPassword(
  token: string,
  password: string,
): Promise<string | null> {
  const tokenHash = hashResetToken(token);
  const passwordHash = await hashPassword(password);
  const result = await db.execute(sql`
    UPDATE password_reset_tokens
    SET consumed_at = NOW()
    WHERE token_hash = ${tokenHash}
      AND consumed_at IS NULL
      AND expires_at > NOW()
    RETURNING user_id
  `);
  const userId = result.rows[0]?.user_id;
  if (typeof userId !== "string" || userId.length === 0) {
    return null;
  }
  await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, userId));
  return userId;
}
