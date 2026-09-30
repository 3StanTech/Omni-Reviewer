import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  citationSourcesForMode,
  readStudyDocumentMeta,
  type CitationSourceRef,
} from "@/lib/citations";
import type { AskOrigin, ChatMessageDto } from "@/lib/ask-types";
import { db } from "@/lib/db";
import { isValidCardFront, parseTestMeItems } from "@/lib/learning";
import { MAX_CARD_BACK_CHARS, MAX_CARD_FRONT_CHARS } from "@/lib/learning-limits";
import { PublicError } from "@/lib/public-errors";
import {
  cards,
  packChatMessages,
  reviewers,
  sources,
  topics,
  views,
  type Card,
  type PackChatMessage,
} from "@/lib/schema";
import { hasMeaningfulText } from "@/lib/source-markers";
import type { TestMeItem } from "@/lib/types";

export type { AskOrigin, ChatMessageDto };

/** `content_json` of an assistant message. User rows store `{ origin }` only. */
export type AskAnswerJson = {
  citationSources: CitationSourceRef[] | null;
  refused: boolean;
  origin: AskOrigin;
  pagesSent?: Record<number, number[]> | "all";
};

/** One stored message row (the table's own columns, camelCase). */
export type ChatMessageRow = PackChatMessage;

/** A question and the answer that replied to it. */
export type ChatExchange = { question: ChatMessageRow | null; answer: ChatMessageRow };

const THREAD_LIMIT = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids arrive from URLs and bodies; a malformed one must not reach a uuid cast. */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** True when the reviewer belongs to the user and is not being deleted. */
function ownedReviewer(reviewerId: string, userId: string) {
  return sql`EXISTS (
    SELECT 1 FROM reviewers AS own_r
    JOIN topics AS own_t ON own_t.id = own_r.topic_id
    WHERE own_r.id = ${reviewerId}
      AND own_t.user_id = ${userId}
      AND own_r.deleting_at IS NULL
  )`;
}

function isAskOrigin(value: unknown): value is AskOrigin {
  if (!value || typeof value !== "object") return false;
  const origin = value as { kind?: unknown; key?: unknown };
  if (origin.kind === "ask") return true;
  return (origin.kind === "explain" || origin.kind === "ask_why") && typeof origin.key === "string";
}

/** Map a stored row to the client DTO, reading `content_json` defensively. */
export function toChatMessageDto(row: ChatMessageRow): ChatMessageDto {
  const json = row.contentJson && typeof row.contentJson === "object" && !Array.isArray(row.contentJson)
    ? (row.contentJson as Record<string, unknown>)
    : {};
  const origin: AskOrigin = isAskOrigin(json.origin)
    ? json.origin.kind === "ask"
      ? { kind: "ask" }
      : { kind: json.origin.kind, key: json.origin.key }
    : { kind: "ask" };
  const citationSources = Array.isArray(json.citationSources)
    ? readStudyDocumentMeta({ citationSources: json.citationSources })?.citationSources ?? null
    : null;
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    refused: json.refused === true,
    saved: row.savedAt !== null,
    origin,
    citationSources,
    replyToId: row.replyToId,
  };
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function asJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Raw `db.execute` rows arrive snake_case, with dates possibly as strings. */
function messageFromRawRow(raw: Record<string, unknown>): ChatMessageRow {
  return {
    id: String(raw.id),
    userId: String(raw.user_id),
    reviewerId: String(raw.reviewer_id),
    role: raw.role === "assistant" ? "assistant" : "user",
    content: String(raw.content ?? ""),
    contentJson: asJson(raw.content_json),
    modelId: (raw.model_id as string | null) ?? null,
    replyToId: (raw.reply_to_id as string | null) ?? null,
    originKey: (raw.origin_key as string | null) ?? null,
    savedAt: asDate(raw.saved_at),
    clearedAt: asDate(raw.cleared_at),
    createdAt: asDate(raw.created_at) ?? new Date(0),
  };
}

/** The uncleared thread, oldest first; at most `limit` of the newest messages. */
export async function listThread(
  reviewerId: string,
  userId: string,
  options: { limit?: number } = {},
): Promise<ChatMessageRow[]> {
  if (!isUuid(reviewerId)) return [];
  const limit = Math.max(1, Math.min(options.limit ?? THREAD_LIMIT, THREAD_LIMIT));
  const rows = await db
    .select()
    .from(packChatMessages)
    .where(and(
      eq(packChatMessages.reviewerId, reviewerId),
      eq(packChatMessages.userId, userId),
      isNull(packChatMessages.clearedAt),
      ownedReviewer(reviewerId, userId),
    ))
    .orderBy(desc(packChatMessages.createdAt), desc(packChatMessages.id))
    .limit(limit);
  return rows.reverse();
}

const questions = alias(packChatMessages, "question");

async function exchanges(
  where: ReturnType<typeof and>,
  order: "saved" | "newest",
  limit?: number,
): Promise<ChatExchange[]> {
  const query = db
    .select({ answer: packChatMessages, question: questions })
    .from(packChatMessages)
    .leftJoin(questions, eq(questions.id, packChatMessages.replyToId))
    .where(where)
    .orderBy(
      order === "saved" ? desc(packChatMessages.savedAt) : desc(packChatMessages.createdAt),
      desc(packChatMessages.id),
    );
  const rows = limit ? await query.limit(limit) : await query;
  return rows.map((row) => ({ question: row.question, answer: row.answer }));
}

/** Saved answers with their questions, newest save first. Clear chat does not hide these. */
export async function listSavedAnswers(reviewerId: string, userId: string): Promise<ChatExchange[]> {
  if (!isUuid(reviewerId)) return [];
  return exchanges(
    and(
      eq(packChatMessages.reviewerId, reviewerId),
      eq(packChatMessages.userId, userId),
      eq(packChatMessages.role, "assistant"),
      isNotNull(packChatMessages.savedAt),
      ownedReviewer(reviewerId, userId),
    ),
    "saved",
  );
}

/** The newest uncleared answer for an Explain or Ask why key, for a free repeat. */
export async function findReusableAnswer(
  reviewerId: string,
  userId: string,
  originKey: string,
): Promise<ChatExchange | null> {
  if (!isUuid(reviewerId) || !originKey) return null;
  const [row] = await exchanges(
    and(
      eq(packChatMessages.reviewerId, reviewerId),
      eq(packChatMessages.userId, userId),
      eq(packChatMessages.role, "assistant"),
      eq(packChatMessages.originKey, originKey),
      isNull(packChatMessages.clearedAt),
      ownedReviewer(reviewerId, userId),
    ),
    "newest",
    1,
  );
  return row ?? null;
}

/**
 * Store a question and its answer in one statement, after the model has
 * answered. The answer replies to the question and sorts just after it.
 * Returns null when the reviewer is not the user's (nothing is written).
 */
export async function insertExchange(args: {
  reviewerId: string;
  userId: string;
  question: string;
  answer: string;
  answerJson: AskAnswerJson;
  modelId: string | null;
  originKey: string | null;
}): Promise<{ question: ChatMessageRow; answer: ChatMessageRow } | null> {
  if (!isUuid(args.reviewerId)) return null;
  const questionJson = JSON.stringify({ origin: args.answerJson.origin });
  const answerJson = JSON.stringify(args.answerJson);
  const result = await db.execute(sql`
    WITH owner AS (
      SELECT r.id
      FROM reviewers AS r
      JOIN topics AS t ON t.id = r.topic_id
      WHERE r.id = ${args.reviewerId}
        AND t.user_id = ${args.userId}
        AND r.deleting_at IS NULL
    ),
    asked AS (
      INSERT INTO pack_chat_messages
        (user_id, reviewer_id, role, content, content_json, origin_key, created_at)
      SELECT ${args.userId}, owner.id, 'user', ${args.question}, ${questionJson}::jsonb,
        ${args.originKey}, clock_timestamp()
      FROM owner
      RETURNING *
    ),
    answered AS (
      INSERT INTO pack_chat_messages
        (user_id, reviewer_id, role, content, content_json, model_id, reply_to_id, origin_key, created_at)
      SELECT ${args.userId}, asked.reviewer_id, 'assistant', ${args.answer}, ${answerJson}::jsonb,
        ${args.modelId}, asked.id, ${args.originKey}, asked.created_at + INTERVAL '1 millisecond'
      FROM asked
      RETURNING *
    )
    SELECT * FROM asked
    UNION ALL
    SELECT * FROM answered
  `);
  const rows = (result.rows as Record<string, unknown>[]).map(messageFromRawRow);
  const question = rows.find((row) => row.role === "user");
  const answer = rows.find((row) => row.role === "assistant");
  return question && answer ? { question, answer } : null;
}

/**
 * Save or unsave an answer to Notes. Only the user's own assistant rows can be
 * changed, and a refused answer cannot be saved. Null means not found.
 */
export async function setSaved(
  messageId: string,
  reviewerId: string,
  userId: string,
  saved: boolean,
): Promise<ChatMessageRow | null> {
  if (!isUuid(messageId) || !isUuid(reviewerId)) return null;
  const [row] = await db
    .update(packChatMessages)
    .set({
      savedAt: saved ? sql`coalesce(${packChatMessages.savedAt}, now())` : null,
    })
    .where(and(
      eq(packChatMessages.id, messageId),
      eq(packChatMessages.reviewerId, reviewerId),
      eq(packChatMessages.userId, userId),
      eq(packChatMessages.role, "assistant"),
      saved
        ? sql`coalesce((${packChatMessages.contentJson} ->> 'refused')::boolean, false) = false`
        : sql`true`,
      ownedReviewer(reviewerId, userId),
    ))
    .returning();
  return row ?? null;
}

/** Hide the whole thread. Saved answers keep showing in Notes. Returns rows hidden. */
export async function clearThread(reviewerId: string, userId: string): Promise<number> {
  if (!isUuid(reviewerId)) return 0;
  const rows = await db
    .update(packChatMessages)
    .set({ clearedAt: sql`now()` })
    .where(and(
      eq(packChatMessages.reviewerId, reviewerId),
      eq(packChatMessages.userId, userId),
      isNull(packChatMessages.clearedAt),
      ownedReviewer(reviewerId, userId),
    ))
    .returning({ id: packChatMessages.id });
  return rows.length;
}

/** Card columns without the generated search vector. */
const cardColumns = {
  id: cards.id,
  reviewerId: cards.reviewerId,
  sourceKey: cards.sourceKey,
  front: cards.front,
  back: cards.back,
  revision: cards.revision,
  isEdited: cards.isEdited,
  isPinned: cards.isPinned,
  archivedAt: cards.archivedAt,
  dueAt: cards.dueAt,
  intervalDays: cards.intervalDays,
  repetitions: cards.repetitions,
  easeFactor: cards.easeFactor,
  lastReviewedAt: cards.lastReviewedAt,
  fsrsState: cards.fsrsState,
  stability: cards.stability,
  difficulty: cards.difficulty,
  lapses: cards.lapses,
  scheduledDays: cards.scheduledDays,
  originGenerationRunId: cards.originGenerationRunId,
  createdAt: cards.createdAt,
  updatedAt: cards.updatedAt,
} satisfies Record<keyof Card, unknown>;

export function askCardSourceKey(messageId: string): string {
  return `ask:${messageId}`;
}

/**
 * Turn an answer into a user-authored card: `is_edited`, FSRS new, due now.
 * Idempotent per message; a repeat returns the existing card with
 * `created: false`. Null when the message is not the user's non-refused answer
 * in this pack. Invalid card text throws a PublicError.
 */
export async function createCardFromMessage(args: {
  messageId: string;
  reviewerId: string;
  userId: string;
  front: string;
  back: string;
}): Promise<{ card: Card; created: boolean } | null> {
  if (!isUuid(args.messageId) || !isUuid(args.reviewerId)) return null;
  const front = args.front.trim();
  const back = args.back.trim();
  if (
    !front ||
    !back ||
    front.length > MAX_CARD_FRONT_CHARS ||
    back.length > MAX_CARD_BACK_CHARS ||
    !isValidCardFront(front)
  ) {
    throw new PublicError("Card front and back must be filled in and within the card limits.");
  }

  const [message] = await db
    .select({ id: packChatMessages.id })
    .from(packChatMessages)
    .where(and(
      eq(packChatMessages.id, args.messageId),
      eq(packChatMessages.reviewerId, args.reviewerId),
      eq(packChatMessages.userId, args.userId),
      eq(packChatMessages.role, "assistant"),
      sql`coalesce((${packChatMessages.contentJson} ->> 'refused')::boolean, false) = false`,
      ownedReviewer(args.reviewerId, args.userId),
    ))
    .limit(1);
  if (!message) return null;

  const sourceKey = askCardSourceKey(message.id);
  const [inserted] = await db
    .insert(cards)
    .values({
      reviewerId: args.reviewerId,
      sourceKey,
      front,
      back,
      isEdited: true,
      fsrsState: 0,
      dueAt: sql`now()`,
    })
    .onConflictDoNothing({ target: [cards.reviewerId, cards.sourceKey] })
    .returning(cardColumns);
  if (inserted) return { card: inserted, created: true };

  const [existing] = await db
    .select(cardColumns)
    .from(cards)
    .where(and(eq(cards.reviewerId, args.reviewerId), eq(cards.sourceKey, sourceKey)))
    .limit(1);
  return existing ? { card: existing, created: false } : null;
}

export type AskSource = { sourceId: string; filename: string; text: string };

/** Ready sources with study text, oldest first: the S1..Sn order Ask cites. */
export async function loadAskSources(reviewerId: string, userId: string): Promise<AskSource[]> {
  if (!isUuid(reviewerId)) return [];
  const rows = await db
    .select({ sourceId: sources.id, filename: sources.filename, text: sources.extractedText })
    .from(sources)
    .innerJoin(reviewers, eq(reviewers.id, sources.reviewerId))
    .innerJoin(topics, eq(topics.id, reviewers.topicId))
    .where(and(
      eq(sources.reviewerId, reviewerId),
      eq(topics.userId, userId),
      isNull(reviewers.deletingAt),
      eq(sources.ingestStatus, "ready"),
      isNull(sources.deletingAt),
    ))
    .orderBy(asc(sources.createdAt), asc(sources.id));
  return rows.flatMap((row) =>
    row.text && hasMeaningfulText(row.text)
      ? [{ sourceId: row.sourceId, filename: row.filename, text: row.text }]
      : [],
  );
}

export type ExplainTarget =
  | {
      type: "test_item";
      item: TestMeItem;
      viewRevision: number;
      citationSources: CitationSourceRef[] | null;
    }
  | {
      type: "card";
      card: { id: string; sourceKey: string; front: string; back: string };
      citationSources: CitationSourceRef[] | null;
    };

type StudyKind = "locked_in" | "summary" | "test_me" | "carded";
type ViewMeta = { contentJson: unknown; generationRunId: string | null } | null;

/**
 * The Test Me item (from the pack's `test_me` view) or the live card an
 * Explain request points at, with the citation sources its text uses.
 * Null for a foreign pack, an unknown item or an archived card.
 */
export async function loadExplainTarget(args: {
  reviewerId: string;
  userId: string;
  target: { type: "test_item"; itemId: string } | { type: "card"; cardId: string };
}): Promise<ExplainTarget | null> {
  if (!isUuid(args.reviewerId)) return null;
  if (args.target.type === "card" && !isUuid(args.target.cardId)) return null;
  const ownKind: StudyKind = args.target.type === "test_item" ? "test_me" : "carded";

  const viewRows = await db
    .select({
      kind: views.kind,
      contentJson: views.contentJson,
      generationRunId: views.generationRunId,
      revision: views.revision,
      // Only the Test Me body is needed; legacy rows keep items in `content`.
      content: sql<string>`CASE WHEN ${views.kind} = 'test_me' THEN ${views.content} ELSE '' END`,
    })
    .from(views)
    .innerJoin(reviewers, eq(reviewers.id, views.reviewerId))
    .innerJoin(topics, eq(topics.id, reviewers.topicId))
    .where(and(
      eq(views.reviewerId, args.reviewerId),
      eq(topics.userId, args.userId),
      isNull(reviewers.deletingAt),
      inArray(views.kind, ["locked_in", "summary", ownKind]),
    ));
  const byKind = new Map(viewRows.map((row) => [row.kind, row]));
  const meta = (kind: StudyKind): ViewMeta => {
    const row = byKind.get(kind);
    return row ? { contentJson: row.contentJson, generationRunId: row.generationRunId } : null;
  };
  const citationSources = citationSourcesForMode(
    { locked_in: meta("locked_in"), summary: meta("summary"), test_me: meta("test_me"), carded: meta("carded") },
    ownKind,
  );

  if (args.target.type === "test_item") {
    const view = byKind.get("test_me");
    if (!view) return null;
    const itemId = args.target.itemId;
    const item = parseTestMeItems(view.contentJson, view.content).find((entry) => entry.id === itemId);
    return item ? { type: "test_item", item, viewRevision: view.revision, citationSources } : null;
  }

  const [card] = await db
    .select({ id: cards.id, sourceKey: cards.sourceKey, front: cards.front, back: cards.back })
    .from(cards)
    .innerJoin(reviewers, eq(reviewers.id, cards.reviewerId))
    .innerJoin(topics, eq(topics.id, reviewers.topicId))
    .where(and(
      eq(cards.id, args.target.cardId),
      eq(cards.reviewerId, args.reviewerId),
      eq(topics.userId, args.userId),
      isNull(reviewers.deletingAt),
      isNull(cards.archivedAt),
    ))
    .limit(1);
  return card ? { type: "card", card, citationSources } : null;
}
