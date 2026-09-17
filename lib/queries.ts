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
  blobReservations,
  generationJobs,
  loginThrottles,
  passwordResetTokens,
  reviewers,
  users,
  sources,
  testSessions,
  testAttempts,
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

export async function listReviewersByTopic(
  topicId: string,
  userId: string,
): Promise<Reviewer[]> {
  return db
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
      revision: views.revision,
      isEdited: views.isEdited,
      isPinned: views.isPinned,
      updatedAt: views.updatedAt,
    })
    .from(views)
    .where(eq(views.reviewerId, reviewerId));
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
      AND (expires_at <= NOW() OR view_revision <> ${expectedRevision})
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
        gt(testSessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(testSessions.startedAt))
    .limit(1);
  if (!row) return null;
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
        AND (expires_at <= NOW() OR view_revision <> ${args.expectedRevision})
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
        started_at,
        expires_at,
        status,
        created_at,
        updated_at
      )
      SELECT
        ${args.userId},
        ${args.reviewerId},
        current_view.revision,
        NOW(),
        NOW() + (${args.durationSeconds} * INTERVAL '1 second'),
        'active'::test_session_status,
        NOW(),
        NOW()
      FROM current_view
      CROSS JOIN (SELECT COUNT(*) AS cleanup_count FROM expired) AS cleanup
      ON CONFLICT (user_id, reviewer_id)
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
        AND ts.status = 'active'::test_session_status
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
    if (currentSession.status === "expired" || currentSession.expiresAt <= new Date()) {
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
      SELECT c.id, c.revision, c.is_edited, c.is_pinned, c.archived_at
      FROM cards c
      INNER JOIN claimed g ON g.reviewer_id = c.reviewer_id
      FOR UPDATE
    ), current_protected AS (
      SELECT CONCAT('card:', c.id::text) AS key, c.revision
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
    ), valid AS (
      SELECT 1 AS ok
      FROM claimed
      WHERE NOT claimed.force_overwrite
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
      WHERE (SELECT force_overwrite FROM claimed)
         OR (cards.is_edited = FALSE AND cards.is_pinned = FALSE)
      RETURNING id
    ), archived AS (
      UPDATE cards c
      SET archived_at = NOW(), updated_at = NOW()
      FROM valid
      WHERE c.reviewer_id = ${args.reviewerId}
        AND NOT EXISTS (SELECT 1 FROM input WHERE input.id = c.source_key)
        AND ((SELECT force_overwrite FROM claimed)
          OR (c.is_edited = FALSE AND c.is_pinned = FALSE))
      RETURNING c.id
    )
    SELECT ok FROM valid
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
}) {
  const reviewer = await getReviewer(args.reviewerId, args.userId);
  if (!reviewer) return null;
  const [current] = await db
    .select()
    .from(cards)
    .where(and(eq(cards.id, args.cardId), eq(cards.reviewerId, args.reviewerId)))
    .limit(1);
  if (!current) return null;
  if (current.revision !== args.expectedRevision) return { stale: true as const };
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
      RETURNING
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
    .select({ kind: views.kind, revision: views.revision, isEdited: views.isEdited, isPinned: views.isPinned })
    .from(views)
    .where(eq(views.reviewerId, reviewerId));
  const kinds = kind === "locked_in" ? ["locked_in", "summary", "test_me", "carded"] : [kind];
  const protectedKinds: Array<{ key: string; revision: number }> = rows
    .filter((row) => kinds.includes(row.kind) && (row.isEdited || row.isPinned))
    .map((row) => ({ key: `view:${row.kind}`, revision: row.revision }));
  if (kind === "locked_in" || kind === "carded") {
    const protectedCards = await db
      .select({ id: cards.id, revision: cards.revision })
      .from(cards)
      .where(
        and(
          eq(cards.reviewerId, reviewerId),
          or(eq(cards.isEdited, true), eq(cards.isPinned, true)),
          isNull(cards.archivedAt),
        ),
      );
    protectedKinds.push(
      ...protectedCards.map((card) => ({ key: `card:${card.id}`, revision: card.revision })),
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
}): Promise<boolean> {
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
  const result = await db.execute(sql`
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
      RETURNING reviewer_id, generation_run_id, step, force_overwrite, expected_protected
    ), locked_views AS MATERIALIZED (
      SELECT v.id, v.kind, v.revision, v.is_edited, v.is_pinned
      FROM views v
      INNER JOIN claimed c ON c.reviewer_id = v.reviewer_id
      WHERE v.kind::text = c.step::text
      FOR UPDATE
    ), locked_cards AS MATERIALIZED (
      SELECT c2.id, c2.revision, c2.is_edited, c2.is_pinned, c2.archived_at
      FROM cards c2
      INNER JOIN claimed c ON c.reviewer_id = c2.reviewer_id
      WHERE c.step = 'carded'::generation_job_step
      FOR UPDATE
    ), current_protected AS (
      SELECT CONCAT('view:', v.kind::text) AS key, v.revision
      FROM locked_views v
      WHERE (v.is_edited OR v.is_pinned)
      UNION ALL
      SELECT CONCAT('card:', c2.id::text) AS key, c2.revision
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
         OR (c.step = 'carded'::generation_job_step AND entry.key LIKE 'card:%')
    ), valid_claim AS (
      SELECT c.*
      FROM claimed c
      WHERE NOT c.force_overwrite
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
      ${args.reviewerId},
      ${args.step}::view_kind,
      ${args.content},
      CAST(${contentJson} AS jsonb),
      ${args.modelUsed},
      generation_run_id,
      ${args.generatedAt}
      ,1
      ,FALSE
      ,FALSE
      ,${args.generatedAt}
    FROM valid_claim
    ON CONFLICT (reviewer_id, kind) DO UPDATE SET
      content = EXCLUDED.content,
      content_json = EXCLUDED.content_json,
      model_id = EXCLUDED.model_id,
      generation_run_id = EXCLUDED.generation_run_id,
      generated_at = EXCLUDED.generated_at,
      revision = views.revision + 1,
      is_edited = FALSE,
      is_pinned = FALSE,
      updated_at = EXCLUDED.updated_at
    WHERE ${args.forceOverwrite} OR (views.is_edited = FALSE AND views.is_pinned = FALSE)
    RETURNING id
  `);
  return result.rows.length > 0;
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
