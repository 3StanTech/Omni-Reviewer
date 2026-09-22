import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ auth: authMock }));

import { POST as reviewPost } from "@/app/api/reviewers/[id]/cards/[cardId]/review/route";
import { POST as sessionPost, GET as sessionGet } from "@/app/api/reviewers/[id]/practice-session/route";
import { POST as attemptsPost } from "@/app/api/reviewers/[id]/test-attempts/route";
import { db } from "@/lib/db";
import {
  createOrResumeTimedTestSession,
  createOrResumeUntimedPracticeSession,
  getUntimedPracticeSession,
  recordUntimedTestAttempt,
  restartUntimedPracticeSession,
  retryMissedUntimedPracticeSession,
  reviewCard,
} from "@/lib/queries";
import { cardReviews, cards, reviewers, testAttempts, testSessions, topics, users, views } from "@/lib/schema";

const runIntegration = process.env.RUN_DB_INTEGRATION === "1";
const describeDb = runIntegration ? describe : describe.skip;

type TestItem = {
  id: string;
  question: string;
  choices: string[];
  answer: string;
  explanation: string;
};

const TWO_ITEMS: TestItem[] = [
  { id: "q1", question: "Q1", choices: ["A", "B"], answer: "A", explanation: "" },
  { id: "q2", question: "Q2", choices: ["C", "D"], answer: "C", explanation: "" },
];

describeDb("practice session SQL integration", () => {
  const userId = randomUUID();
  let revision = 1;

  beforeAll(async () => {
    authMock.mockResolvedValue({ user: { id: userId } });
    await db.insert(users).values({
      id: userId,
      email: `practice-integration-${userId}@example.invalid`,
      passwordHash: "integration-only",
    });
  }, 60_000);

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
  }, 60_000);

  async function seedPack(items: TestItem[]) {
    revision = 1;
    const topicId = randomUUID();
    const reviewerId = randomUUID();
    const viewId = randomUUID();
    const cardId = randomUUID();
    await db.insert(topics).values({ id: topicId, userId, name: `Practice ${topicId}` });
    await db.insert(reviewers).values({ id: reviewerId, topicId, name: "Practice integration" });
    await db.insert(views).values({
      id: viewId,
      reviewerId,
      kind: "test_me",
      revision,
      content: JSON.stringify(items),
      contentJson: items,
    });
    await db.insert(cards).values({
      id: cardId,
      reviewerId,
      sourceKey: "c1",
      front: "Front",
      back: "Back",
    });
    return { reviewerId, viewId, cardId };
  }

  async function replaceTest(viewId: string, nextRevision: number, items: TestItem[]) {
    revision = nextRevision;
    await db.update(views).set({
      revision: nextRevision,
      content: JSON.stringify(items),
      contentJson: items,
    }).where(eq(views.id, viewId));
  }

  async function activeSittings(reviewerId: string) {
    return db.select().from(testSessions).where(and(
      eq(testSessions.reviewerId, reviewerId),
      eq(testSessions.userId, userId),
      eq(testSessions.mode, "untimed"),
      eq(testSessions.status, "active"),
    ));
  }

  function sessionRequest(reviewerId: string, body: unknown) {
    return sessionPost(
      new Request("https://omni-reviewer.example/api/practice-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: reviewerId }) },
    );
  }

  function attemptRequest(reviewerId: string, body: unknown) {
    return attemptsPost(
      new Request("https://omni-reviewer.example/api/test-attempts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: reviewerId }) },
    );
  }

  it("serializes concurrent untimed create, restart, and retry onto one active snapshot", async () => {
    const { reviewerId } = await seedPack(TWO_ITEMS);
    const created = await Promise.all(Array.from({ length: 8 }, () =>
      createOrResumeUntimedPracticeSession({ userId, reviewerId, expectedRevision: 1 }),
    ));
    const createdIds = new Set(created.map((row) => row?.id));
    expect(created.every((row) => row?.itemIds.join() === "q1,q2")).toBe(true);
    expect(createdIds.size).toBe(1);
    expect(await activeSittings(reviewerId)).toHaveLength(1);

    const first = created[0];
    if (!first) throw new Error("untimed sitting was not created");
    await recordUntimedTestAttempt({
      userId,
      reviewerId,
      sessionId: first.id,
      expectedRevision: 1,
      itemId: "q1",
      selectedAnswer: "B",
    });
    await recordUntimedTestAttempt({
      userId,
      reviewerId,
      sessionId: first.id,
      expectedRevision: 1,
      itemId: "q2",
      selectedAnswer: "C",
    });
    const retried = await Promise.all(Array.from({ length: 6 }, () =>
      retryMissedUntimedPracticeSession({
        userId,
        reviewerId,
        expectedRevision: 1,
        originSessionId: first.id,
      }),
    ));
    const retryRows = retried.filter((row) => "id" in row);
    expect(retryRows).toHaveLength(retried.length);
    expect(retryRows.every((row) => row.itemIds.join() === "q1" && row.originSessionId === first.id)).toBe(true);
    const activeAfterRetry = await activeSittings(reviewerId);
    expect(activeAfterRetry).toHaveLength(1);
    expect(activeAfterRetry[0]?.itemIds).toEqual(["q1"]);
    expect(activeAfterRetry[0]?.originSessionId).toBe(first.id);
    for (const row of retryRows) {
      const [stored] = await db.select({ status: testSessions.status }).from(testSessions).where(eq(testSessions.id, row.id));
      expect(stored?.status).toBe(row.id === activeAfterRetry[0]?.id ? "active" : "expired");
    }
    const [origin] = await db.select({ status: testSessions.status }).from(testSessions).where(eq(testSessions.id, first.id));
    expect(origin?.status).toBe("completed");

    const restarted = await Promise.all(Array.from({ length: 6 }, () =>
      restartUntimedPracticeSession({ userId, reviewerId, expectedRevision: 1 }),
    ));
    const activeAfterRestart = await activeSittings(reviewerId);
    expect(activeAfterRestart).toHaveLength(1);
    expect(activeAfterRestart[0]?.itemIds).toEqual(["q1", "q2"]);
    expect(activeAfterRestart[0]?.answeredCount).toBe(0);
    const activeId = activeAfterRestart[0]?.id;
    expect(restarted.every((row) => row?.itemIds.join() === "q1,q2")).toBe(true);
    for (const row of restarted) {
      if (!row) throw new Error("restart did not return a sitting");
      const [stored] = await db.select({ status: testSessions.status }).from(testSessions).where(eq(testSessions.id, row.id));
      expect(stored?.status).toBe(row.id === activeId ? "active" : "expired");
    }
  }, 30_000);

  it("replays the same untimed answer and rejects a second tab's different answer", async () => {
    const { reviewerId } = await seedPack(TWO_ITEMS);
    const session = await createOrResumeUntimedPracticeSession({ userId, reviewerId, expectedRevision: 1 });
    if (!session) throw new Error("untimed sitting was not created");

    const firstWave = await Promise.all(Array.from({ length: 8 }, () =>
      recordUntimedTestAttempt({
        userId,
        reviewerId,
        sessionId: session.id,
        expectedRevision: 1,
        itemId: "q1",
        selectedAnswer: "A",
      }),
    ));
    expect(firstWave.every((result) => "answer" in result && result.answer.selectedAnswer === "A")).toBe(true);
    expect(firstWave.filter((result) => "alreadySaved" in result && result.alreadySaved).length).toBe(7);
    const saved = await db.select().from(testAttempts).where(eq(testAttempts.sessionId, session.id));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ selectedAnswer: "A", correct: true });
    const [progress] = await db.select({
      answeredCount: testSessions.answeredCount,
      status: testSessions.status,
    }).from(testSessions).where(eq(testSessions.id, session.id));
    expect(progress).toEqual({ answeredCount: 1, status: "active" });

    const conflict = await attemptRequest(reviewerId, {
      mode: "untimed",
      expectedRevision: 1,
      sessionId: session.id,
      itemId: "q1",
      selectedAnswer: "B",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ conflict: true });
    const afterConflict = await db.select().from(testAttempts).where(eq(testAttempts.sessionId, session.id));
    expect(afterConflict).toHaveLength(1);
    expect(afterConflict[0]?.selectedAnswer).toBe("A");

    const replay = await attemptRequest(reviewerId, {
      mode: "untimed",
      expectedRevision: 1,
      sessionId: session.id,
      itemId: "q1",
      selectedAnswer: "A",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      alreadySaved: true,
      completed: false,
      answer: { itemId: "q1", selectedAnswer: "A", correct: true },
    });

    const finals = await Promise.all([
      recordUntimedTestAttempt({
        userId,
        reviewerId,
        sessionId: session.id,
        expectedRevision: 1,
        itemId: "q2",
        selectedAnswer: "D",
      }),
      recordUntimedTestAttempt({
        userId,
        reviewerId,
        sessionId: session.id,
        expectedRevision: 1,
        itemId: "q2",
        selectedAnswer: "D",
      }),
    ]);
    expect(finals.every((result) => "answer" in result)).toBe(true);
    expect(finals.some((result) => "completed" in result && result.completed)).toBe(true);
    const [completed] = await db.select({
      status: testSessions.status,
      answeredCount: testSessions.answeredCount,
    }).from(testSessions).where(eq(testSessions.id, session.id));
    expect(completed).toEqual({ status: "completed", answeredCount: 2 });
    const resumed = await getUntimedPracticeSession({ userId, reviewerId, expectedRevision: 1 });
    expect(resumed?.id).toBe(session.id);
    expect(resumed?.answers.map((answer) => answer.itemId).sort()).toEqual(["q1", "q2"]);

    const retry = await retryMissedUntimedPracticeSession({
      userId,
      reviewerId,
      expectedRevision: 1,
      originSessionId: session.id,
    });
    if (!retry || !("id" in retry)) throw new Error("retry missed did not open");
    expect(retry.itemIds).toEqual(["q2"]);
    const outside = await recordUntimedTestAttempt({
      userId,
      reviewerId,
      sessionId: retry.id,
      expectedRevision: 1,
      itemId: "q1",
      selectedAnswer: "A",
    });
    expect(outside).toEqual({ invalid: true });
    expect(await db.select().from(testAttempts).where(eq(testAttempts.sessionId, retry.id))).toHaveLength(0);
    expect(await db.select().from(testAttempts).where(eq(testAttempts.sessionId, session.id))).toHaveLength(2);

    const inProgress = await restartUntimedPracticeSession({ userId, reviewerId, expectedRevision: 1 });
    if (!inProgress) throw new Error("restart did not open");
    const kept = await recordUntimedTestAttempt({
      userId,
      reviewerId,
      sessionId: inProgress.id,
      expectedRevision: 1,
      itemId: "q1",
      selectedAnswer: "B",
    });
    expect("answer" in kept).toBe(true);
    const blocked = await retryMissedUntimedPracticeSession({
      userId,
      reviewerId,
      expectedRevision: 1,
      originSessionId: session.id,
    });
    expect(blocked).toEqual({ conflict: true });
    const stillActive = await activeSittings(reviewerId);
    expect(stillActive.map((row) => row.id)).toEqual([inProgress.id]);
    const routeConflict = await sessionRequest(reviewerId, {
      expectedRevision: 1,
      intent: "retry_missed",
      originSessionId: session.id,
    });
    expect(routeConflict.status).toBe(409);
    await expect(routeConflict.json()).resolves.toMatchObject({ conflict: true });
  }, 30_000);

  it("expires the old sitting on the next read after regeneration and refuses its answers", async () => {
    const { reviewerId, viewId } = await seedPack(TWO_ITEMS);
    const started = await sessionRequest(reviewerId, { expectedRevision: 1, intent: "start" });
    expect(started.status).toBe(200);
    const payload = await started.json() as { sessionId: string; itemIds: string[] };
    expect(payload.itemIds).toEqual(["q1", "q2"]);
    await recordUntimedTestAttempt({
      userId,
      reviewerId,
      sessionId: payload.sessionId,
      expectedRevision: 1,
      itemId: "q1",
      selectedAnswer: "A",
    });

    const replacement = [{ id: "q9", question: "Q9", choices: ["A", "B"], answer: "A", explanation: "" }];
    await replaceTest(viewId, 2, replacement);

    const staleAnswer = await attemptRequest(reviewerId, {
      mode: "untimed",
      expectedRevision: 1,
      sessionId: payload.sessionId,
      itemId: "q1",
      selectedAnswer: "B",
    });
    expect(staleAnswer.status).toBe(409);
    const wrongSitting = await recordUntimedTestAttempt({
      userId,
      reviewerId,
      sessionId: payload.sessionId,
      expectedRevision: 2,
      itemId: "q9",
      selectedAnswer: "A",
    });
    expect(wrongSitting).toEqual({ stale: true });
    expect(await db.select().from(testAttempts).where(eq(testAttempts.sessionId, payload.sessionId))).toHaveLength(1);

    const resumed = await sessionGet(
      new Request(`https://omni-reviewer.example/api/practice-session?expectedRevision=2`),
      { params: Promise.resolve({ id: reviewerId }) },
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ session: null });
    const [expired] = await db.select({ status: testSessions.status }).from(testSessions).where(eq(testSessions.id, payload.sessionId));
    expect(expired?.status).toBe("expired");

    const restarted = await createOrResumeUntimedPracticeSession({ userId, reviewerId, expectedRevision: 2 });
    expect(restarted?.id).not.toBe(payload.sessionId);
    expect(restarted?.itemIds).toEqual(["q9"]);
    expect(await activeSittings(reviewerId)).toHaveLength(1);
    const historical = await db.select().from(testAttempts).where(eq(testAttempts.sessionId, payload.sessionId));
    expect(historical).toHaveLength(1);
    expect(historical[0]?.selectedAnswer).toBe("A");

    const missed = await retryMissedUntimedPracticeSession({
      userId,
      reviewerId,
      expectedRevision: 2,
      originSessionId: payload.sessionId,
    });
    expect(missed).toEqual({ stale: true });
  }, 30_000);

  it("keeps one card schedule for a replayed request and one winner for two tabs", async () => {
    const { reviewerId, cardId } = await seedPack(TWO_ITEMS);
    const requestId = randomUUID();
    const replayed = await Promise.all(Array.from({ length: 6 }, () =>
      reviewCard({
        reviewerId,
        userId,
        cardId,
        expectedRevision: 1,
        rating: "good",
        clientRequestId: requestId,
      }),
    ));
    expect(replayed.every((row) => row && !("stale" in row))).toBe(true);
    const history = await db.select().from(cardReviews).where(eq(cardReviews.cardId, cardId));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ clientRequestId: requestId, rating: "good" });
    const [scheduled] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(scheduled).toMatchObject({ revision: 2, repetitions: 1, intervalDays: 1, easeFactor: 25 });

    const sameRequestDifferentRating = await reviewPost(
      new Request("https://omni-reviewer.example/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, rating: "again", clientRequestId: requestId }),
      }),
      { params: Promise.resolve({ id: reviewerId, cardId }) },
    );
    expect(sameRequestDifferentRating.status).toBe(200);
    const [unchanged] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(unchanged).toMatchObject({
      revision: scheduled?.revision,
      dueAt: scheduled?.dueAt,
      repetitions: 1,
      intervalDays: 1,
      easeFactor: 25,
    });
    expect(await db.select().from(cardReviews).where(eq(cardReviews.cardId, cardId))).toHaveLength(1);

    const againId = randomUUID();
    const goodId = randomUUID();
    const raced = await Promise.all([
      reviewCard({
        reviewerId,
        userId,
        cardId,
        expectedRevision: 2,
        rating: "again",
        clientRequestId: againId,
      }),
      reviewCard({
        reviewerId,
        userId,
        cardId,
        expectedRevision: 2,
        rating: "good",
        clientRequestId: goodId,
      }),
    ]);
    expect(raced.filter((row) => row && !("stale" in row))).toHaveLength(1);
    expect(raced.filter((row) => row && "stale" in row)).toHaveLength(1);
    const afterRace = await db.select().from(cardReviews).where(eq(cardReviews.cardId, cardId));
    expect(afterRace).toHaveLength(2);
    const [once] = await db.select().from(cards).where(eq(cards.id, cardId));
    const singleStep = once?.easeFactor === 23
      ? { repetitions: 0, intervalDays: 1, easeFactor: 23 }
      : { repetitions: 2, intervalDays: 6, easeFactor: 25 };
    expect(once).toMatchObject({ revision: 3, ...singleStep });
  }, 30_000);

  it("isolates sittings and reviews from another owner without disturbing them", async () => {
    const { reviewerId, cardId } = await seedPack(TWO_ITEMS);
    const session = await createOrResumeUntimedPracticeSession({ userId, reviewerId, expectedRevision: 1 });
    if (!session) throw new Error("untimed sitting was not created");
    const timed = await createOrResumeTimedTestSession({
      userId,
      reviewerId,
      expectedRevision: 1,
      durationSeconds: 60,
    });
    if (!timed) throw new Error("timed sitting was not created");
    expect(timed.id).not.toBe(session.id);

    const otherUserId = randomUUID();
    await db.insert(users).values({
      id: otherUserId,
      email: `practice-other-${otherUserId}@example.invalid`,
      passwordHash: "integration-only",
    });
    authMock.mockResolvedValue({ user: { id: otherUserId } });
    try {
      const otherSession = await sessionRequest(reviewerId, { expectedRevision: 1, intent: "start" });
      expect(otherSession.status).toBe(404);
      const otherAnswer = await attemptRequest(reviewerId, {
        mode: "untimed",
        expectedRevision: 1,
        sessionId: session.id,
        itemId: "q1",
        selectedAnswer: "A",
      });
      expect(otherAnswer.status).toBe(404);
      const otherReview = await reviewPost(
        new Request("https://omni-reviewer.example/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: 1, rating: "good", clientRequestId: randomUUID() }),
        }),
        { params: Promise.resolve({ id: reviewerId, cardId }) },
      );
      expect(otherReview.status).toBe(404);
      await expect(recordUntimedTestAttempt({
        userId: otherUserId,
        reviewerId,
        sessionId: session.id,
        expectedRevision: 1,
        itemId: "q1",
        selectedAnswer: "A",
      })).resolves.toEqual({ missing: true });
      await expect(reviewCard({
        reviewerId,
        userId: otherUserId,
        cardId,
        expectedRevision: 1,
        rating: "again",
        clientRequestId: randomUUID(),
      })).resolves.toBeNull();
    } finally {
      authMock.mockResolvedValue({ user: { id: userId } });
      await db.delete(users).where(eq(users.id, otherUserId));
    }

    const stillActive = await activeSittings(reviewerId);
    expect(stillActive.map((row) => row.id)).toEqual([session.id]);
    expect(await db.select().from(testAttempts).where(eq(testAttempts.sessionId, session.id))).toHaveLength(0);
    expect(await db.select().from(cardReviews).where(eq(cardReviews.cardId, cardId))).toHaveLength(0);
    const timedRow = await db.select({ status: testSessions.status, mode: testSessions.mode }).from(testSessions).where(eq(testSessions.id, timed.id));
    expect(timedRow).toEqual([{ status: "active", mode: "timed" }]);
  }, 30_000);

  it("rejects an untimed deadline and a timed sitting without one", async () => {
    const { reviewerId } = await seedPack(TWO_ITEMS);
    await expect(db.insert(testSessions).values({
      userId,
      reviewerId,
      viewRevision: 1,
      mode: "untimed",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      itemIds: ["q1"],
    })).rejects.toThrow();
    await expect(db.insert(testSessions).values({
      userId,
      reviewerId,
      viewRevision: 1,
      mode: "timed",
      startedAt: new Date(),
      expiresAt: null,
      itemIds: [],
    })).rejects.toThrow();
  }, 30_000);
});
