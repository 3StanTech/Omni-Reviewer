import { describe, expect, it } from "vitest";

import {
  canRetryMissed,
  captureDueQueue,
  isValidPracticeExpiry,
  missedItemIds,
  nextUnratedIndex,
  reconcileDueSession,
  resolveCardReviewRequest,
  resolveSessionAnswer,
  resolveUntimedAttemptReread,
  sameItemSnapshot,
  sittingProgress,
  snapshotTestItemIds,
} from "@/lib/practice-session";

function card(id: string, dueOffsetMs: number, revision = 1) {
  return {
    id,
    revision,
    dueAt: new Date(1_000 + dueOffsetMs).toISOString(),
  };
}

describe("finite Carded due sessions", () => {
  const now = 1_000;

  it("captures only cards due at session start, in the given order", () => {
    expect(captureDueQueue([
      card("later", 60_000),
      card("due-a", 0),
      card("due-b", -1),
      { ...card("archived", -1), archivedAt: new Date(now).toISOString() },
    ], now)).toEqual([
      { id: "due-a", revision: 1 },
      { id: "due-b", revision: 1 },
    ]);
  });

  it("rates each queued card once and ignores newly due cards until the next session", () => {
    const queue = captureDueQueue([card("a", -1), card("b", -1)], now);
    const afterFirst = reconcileDueSession({
      queue,
      cards: [card("a", 86_400_000, 2), card("b", -1), card("c", -1)],
      ratedIds: new Set(["a"]),
    });
    expect(afterFirst.completed).toBe(1);
    expect(afterFirst.total).toBe(2);
    expect(afterFirst.current?.id).toBe("b");
    expect(afterFirst.remaining.map((entry) => entry.id)).toEqual(["b"]);
    expect(afterFirst.finished).toBe(false);
  });

  it("does not advance when a rating is still outstanding", () => {
    const queue = captureDueQueue([card("a", -1), card("b", -1)], now);
    expect(nextUnratedIndex(queue, new Set())).toBe(0);
    expect(nextUnratedIndex(queue, new Set(["a"]))).toBe(1);
  });

  it("treats a zero-due capture as a useful empty session", () => {
    const session = reconcileDueSession({
      queue: captureDueQueue([card("later", 60_000)], now),
      cards: [card("later", 60_000)],
      ratedIds: new Set(),
    });
    expect(session.empty).toBe(true);
    expect(session.finished).toBe(false);
    expect(session.current).toBeNull();
  });

  it("finishes after every captured card is rated or missing", () => {
    const queue = [{ id: "a", revision: 1 }, { id: "gone", revision: 1 }];
    const session = reconcileDueSession({
      queue,
      cards: [card("a", 86_400_000, 2)],
      ratedIds: new Set(["a"]),
    });
    expect(session.finished).toBe(true);
    expect(session.completed).toBe(1);
    expect(session.remaining).toEqual([]);
  });

  it("marks revision changes as stale without dropping the card from the queue", () => {
    const session = reconcileDueSession({
      queue: [{ id: "a", revision: 1 }],
      cards: [card("a", -1, 4)],
      ratedIds: new Set(),
    });
    expect(session.current).toMatchObject({ id: "a", stale: true, missing: false });
  });

  it("replays the same client request and rejects a later revision as stale", () => {
    expect(resolveCardReviewRequest({
      expectedRevision: 3,
      currentRevision: 4,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      existingRequestId: "11111111-1111-4111-8111-111111111111",
    })).toBe("replay");
    expect(resolveCardReviewRequest({
      expectedRevision: 3,
      currentRevision: 4,
    })).toBe("stale");
    expect(resolveCardReviewRequest({
      expectedRevision: 3,
      currentRevision: 3,
    })).toBe("apply");
  });
});

describe("durable untimed Test Me sittings", () => {
  const items = [{ id: "q1" }, { id: "q2" }, { id: "q3" }];

  it("snapshots ordered item ids and reconstructs the next unanswered item", () => {
    const itemIds = snapshotTestItemIds(items);
    const progress = sittingProgress(itemIds, [
      { itemId: "q1", selectedAnswer: "A", correct: true },
    ]);
    expect(itemIds).toEqual(["q1", "q2", "q3"]);
    expect(progress).toMatchObject({
      answeredCount: 1,
      correctCount: 1,
      nextItemId: "q2",
      nextIndex: 1,
      complete: false,
    });
  });

  it("treats a same-answer retry as idempotent and a different answer as a conflict", () => {
    expect(resolveSessionAnswer(null, "A")).toBe("insert");
    expect(resolveSessionAnswer({ selectedAnswer: "A" }, "A")).toBe("idempotent");
    expect(resolveSessionAnswer({ selectedAnswer: "A" }, "B")).toBe("conflict");
  });

  it("does not apply an answer for an item outside the sitting snapshot", () => {
    const session = {
      status: "active" as const,
      viewRevision: 4,
      itemIds: ["q2", "q3"],
    };
    expect(resolveUntimedAttemptReread({
      session,
      existing: null,
      expectedRevision: 4,
      itemId: "q1",
      submitted: "A",
    })).toBe("invalid");
    expect(resolveUntimedAttemptReread({
      session,
      existing: { selectedAnswer: "B" },
      expectedRevision: 4,
      itemId: "q2",
      submitted: "B",
    })).toBe("idempotent");
    expect(resolveUntimedAttemptReread({
      session,
      existing: { selectedAnswer: "B" },
      expectedRevision: 4,
      itemId: "q2",
      submitted: "C",
    })).toBe("conflict");
    expect(resolveUntimedAttemptReread({
      session: { ...session, viewRevision: 3 },
      existing: null,
      expectedRevision: 4,
      itemId: "q2",
      submitted: "A",
    })).toBe("stale");
    expect(sameItemSnapshot(["q2", "q3"], ["q2", "q3"])).toBe(true);
    expect(sameItemSnapshot(["q2", "q3"], ["q1", "q2", "q3"])).toBe(false);
  });

  it("retries only incorrect items from a completed sitting at the same revision", () => {
    const itemIds = ["q1", "q2", "q3"];
    const answers = [
      { itemId: "q1", selectedAnswer: "A", correct: true },
      { itemId: "q2", selectedAnswer: "B", correct: false },
      { itemId: "q3", selectedAnswer: "C", correct: false },
    ];
    expect(missedItemIds(itemIds, answers)).toEqual(["q2", "q3"]);
    expect(canRetryMissed({
      status: "completed",
      viewRevision: 4,
      expectedRevision: 4,
      itemIds,
      answers,
    })).toBe(true);
    expect(canRetryMissed({
      status: "completed",
      viewRevision: 4,
      expectedRevision: 5,
      itemIds,
      answers,
    })).toBe(false);
    expect(canRetryMissed({
      status: "active",
      viewRevision: 4,
      expectedRevision: 4,
      itemIds,
      answers,
    })).toBe(false);
    expect(canRetryMissed({
      status: "completed",
      viewRevision: 4,
      expectedRevision: 4,
      itemIds,
      answers: answers.map((answer) => ({ ...answer, correct: true })),
    })).toBe(false);
  });

  it("requires a deadline only for timed mode", () => {
    expect(isValidPracticeExpiry("untimed", null)).toBe(true);
    expect(isValidPracticeExpiry("untimed", new Date())).toBe(false);
    expect(isValidPracticeExpiry("timed", null)).toBe(false);
    expect(isValidPracticeExpiry("timed", new Date("2026-09-21T00:00:00.000Z"))).toBe(true);
  });

  it("marks a sitting complete only after every snapshotted item has an accepted answer", () => {
    const progress = sittingProgress(["q1", "q2"], [
      { itemId: "q1", selectedAnswer: "A", correct: true },
      { itemId: "q2", selectedAnswer: "B", correct: false },
      { itemId: "ghost", selectedAnswer: "Z", correct: true },
    ]);
    expect(progress.complete).toBe(true);
    expect(progress.correctCount).toBe(1);
    expect(progress.answeredCount).toBe(2);
  });
});
