import { MAX_TEST_ATTEMPT_ITEMS, MAX_TEST_ME_ITEMS } from "@/lib/learning-limits";

export type PracticeSessionMode = "timed" | "untimed";

export type DurableCardLike = {
  id: string;
  revision: number;
  dueAt: string | Date;
  archivedAt?: string | Date | null;
};

export type CapturedCard = {
  id: string;
  revision: number;
};

export type PracticeAnswer = {
  itemId: string;
  selectedAnswer: string;
  correct: boolean;
};

export type SittingItemLike = {
  id: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCardDueAt(dueAt: string | Date, nowMs: number): boolean {
  const due = dueAt instanceof Date ? dueAt.getTime() : new Date(dueAt).getTime();
  return Number.isFinite(due) && due <= nowMs;
}

function isArchived(value: DurableCardLike["archivedAt"]): boolean {
  return value != null && value !== "";
}

/** Ordered due membership at session start. Scheduler math is not applied here. */
export function captureDueQueue(
  cards: readonly DurableCardLike[],
  nowMs: number,
): CapturedCard[] {
  return cards
    .filter((card) => !isArchived(card.archivedAt) && isCardDueAt(card.dueAt, nowMs))
    .map((card) => ({ id: card.id, revision: card.revision }));
}

export type ReconciledQueueCard<T extends DurableCardLike = DurableCardLike> = {
  id: string;
  capturedRevision: number;
  card: T | null;
  missing: boolean;
  stale: boolean;
  rated: boolean;
};

export type ReconciledDueSession<T extends DurableCardLike = DurableCardLike> = {
  total: number;
  completed: number;
  remaining: ReconciledQueueCard<T>[];
  current: ReconciledQueueCard<T> | null;
  finished: boolean;
  empty: boolean;
};

export function reconcileDueSession<T extends DurableCardLike>(args: {
  queue: readonly CapturedCard[];
  cards: readonly T[];
  ratedIds: ReadonlySet<string>;
}): ReconciledDueSession<T> {
  const byId = new Map(args.cards.map((card) => [card.id, card]));
  const remaining: ReconciledQueueCard<T>[] = [];
  let completed = 0;
  for (const captured of args.queue) {
    const card = byId.get(captured.id) ?? null;
    const missing = !card || isArchived(card.archivedAt);
    const stale = Boolean(card && !missing && card.revision !== captured.revision);
    const rated = args.ratedIds.has(captured.id);
    if (rated || missing) {
      if (rated) completed += 1;
      continue;
    }
    remaining.push({
      id: captured.id,
      capturedRevision: captured.revision,
      card,
      missing,
      stale,
      rated: false,
    });
  }
  const current = remaining[0] ?? null;
  return {
    total: args.queue.length,
    completed,
    remaining,
    current,
    finished: args.queue.length > 0 && remaining.length === 0,
    empty: args.queue.length === 0,
  };
}

export function nextUnratedIndex(queue: readonly CapturedCard[], ratedIds: ReadonlySet<string>): number {
  return queue.findIndex((entry) => !ratedIds.has(entry.id));
}

export type CardReviewDecision = "apply" | "replay" | "stale";

export function resolveCardReviewRequest(args: {
  expectedRevision: number;
  currentRevision: number;
  clientRequestId?: string | null;
  existingRequestId?: string | null;
}): CardReviewDecision {
  if (args.clientRequestId && args.existingRequestId && args.clientRequestId === args.existingRequestId) {
    return "replay";
  }
  if (args.currentRevision !== args.expectedRevision) return "stale";
  return "apply";
}

export type SessionAnswerDecision = "insert" | "idempotent" | "conflict";

export function resolveSessionAnswer(
  existing: { selectedAnswer: string } | null | undefined,
  submitted: string,
): SessionAnswerDecision {
  if (!existing) return "insert";
  return existing.selectedAnswer === submitted ? "idempotent" : "conflict";
}

export function sameItemSnapshot(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((itemId, index) => itemId === right[index]);
}

export type UntimedAttemptReread =
  | "missing"
  | "stale"
  | "conflict"
  | "invalid"
  | "idempotent";

/** Fallback when the atomic write CTE did not produce a written row. */
export function resolveUntimedAttemptReread(args: {
  session: {
    status: "active" | "completed" | "expired";
    viewRevision: number;
    itemIds: readonly string[];
  } | null;
  existing: { selectedAnswer: string } | null;
  expectedRevision: number;
  itemId: string;
  submitted: string;
}): UntimedAttemptReread {
  if (!args.session) return "missing";
  if (args.session.viewRevision !== args.expectedRevision) return "stale";
  if (args.existing) {
    return args.existing.selectedAnswer === args.submitted ? "idempotent" : "conflict";
  }
  if (!args.session.itemIds.includes(args.itemId)) return "invalid";
  if (args.session.status === "completed" || args.session.status === "expired") return "conflict";
  return "missing";
}

export function snapshotTestItemIds(items: readonly SittingItemLike[]): string[] {
  const ids = items.map((item) => item.id).filter((id) => id.length > 0);
  return ids.slice(0, Math.min(MAX_TEST_ME_ITEMS, MAX_TEST_ATTEMPT_ITEMS));
}

export function missedItemIds(
  itemIds: readonly string[],
  answers: readonly PracticeAnswer[],
): string[] {
  const byId = new Map(answers.map((answer) => [answer.itemId, answer]));
  return itemIds.filter((itemId) => byId.get(itemId)?.correct === false);
}

export type SittingProgress = {
  answeredCount: number;
  correctCount: number;
  nextItemId: string | null;
  nextIndex: number;
  complete: boolean;
  answersByItemId: Record<string, PracticeAnswer>;
};

export function sittingProgress(
  itemIds: readonly string[],
  answers: readonly PracticeAnswer[],
): SittingProgress {
  const answersByItemId: Record<string, PracticeAnswer> = {};
  for (const answer of answers) {
    if (!itemIds.includes(answer.itemId)) continue;
    answersByItemId[answer.itemId] = answer;
  }
  const nextIndex = itemIds.findIndex((itemId) => !(itemId in answersByItemId));
  const complete = itemIds.length > 0 && nextIndex === -1;
  return {
    answeredCount: Object.keys(answersByItemId).length,
    correctCount: Object.values(answersByItemId).filter((answer) => answer.correct).length,
    nextItemId: complete ? null : itemIds[nextIndex] ?? null,
    nextIndex: complete ? Math.max(0, itemIds.length - 1) : Math.max(0, nextIndex),
    complete,
    answersByItemId,
  };
}

export function canRetryMissed(args: {
  status: "active" | "completed" | "expired";
  viewRevision: number;
  expectedRevision: number;
  itemIds: readonly string[];
  answers: readonly PracticeAnswer[];
}): boolean {
  if (args.status !== "completed") return false;
  if (args.viewRevision !== args.expectedRevision) return false;
  return missedItemIds(args.itemIds, args.answers).length > 0;
}

export function isValidPracticeExpiry(
  mode: PracticeSessionMode,
  expiresAt: Date | string | null | undefined,
): boolean {
  if (mode === "untimed") return expiresAt == null;
  if (expiresAt == null) return false;
  const expires = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return Number.isFinite(expires);
}

export function isClientRequestId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function sittingItemsForIds<T extends SittingItemLike>(
  items: readonly T[],
  itemIds: readonly string[],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return itemIds.flatMap((itemId) => {
    const item = byId.get(itemId);
    return item ? [item] : [];
  });
}
