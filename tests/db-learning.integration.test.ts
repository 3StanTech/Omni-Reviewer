import { randomUUID } from "node:crypto";

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("server-only", () => ({}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ auth: authMock }));

import { db } from "@/lib/db";
import {
  beginReviewerDeletion,
  beginSourceDeletion,
  beginTopicDeletion,
  claimBlobDeletion,
  completeBlobDeletion,
  createSourceForOwner,
  createOrResumeTimedTestSession,
  deleteSourceForOwner,
  getActiveTimedTestSession,
  getReviewer,
  releaseBlobReservation,
  requeueBlobDeletion,
  recordTestAttempts,
  recordTimedTestAttempt,
  reserveBlobForRegistration,
  reviewCard,
  serializeCard,
  updateStudyView,
} from "@/lib/queries";
import {
  blobReservations,
  cardReviews,
  cards,
  reviewers,
  sources,
  testAttempts,
  testSessions,
  topics,
  users,
  views,
} from "@/lib/schema";
import { POST as attemptsPost } from "@/app/api/reviewers/[id]/test-attempts/route";
import { POST as reviewPost } from "@/app/api/reviewers/[id]/cards/[cardId]/review/route";

const runIntegration = process.env.RUN_DB_INTEGRATION === "1";
const describeDb = runIntegration ? describe : describe.skip;

describeDb("Neon learning integration", () => {
  const userId = randomUUID();
  const topicId = randomUUID();
  const reviewerId = randomUUID();
  const cardId = randomUUID();
  const viewId = randomUUID();
  const generationRunId = randomUUID();

  beforeAll(async () => {
    authMock.mockResolvedValue({ user: { id: userId } });
    await db.insert(users).values({
      id: userId,
      email: `learning-integration-${userId}@example.invalid`,
      passwordHash: "integration-only",
    });
    await db.insert(topics).values({ id: topicId, userId, name: "Integration" });
    await db.insert(reviewers).values({ id: reviewerId, topicId, name: "Learning integration" });
    await db.insert(views).values({
      id: viewId,
      reviewerId,
      kind: "test_me",
      content: JSON.stringify([{
        id: "q1",
        question: "Which answer?",
        choices: ["A", "B"],
        answer: "A",
        explanation: "A is correct.",
      }]),
      contentJson: [{
        id: "q1",
        question: "Which answer?",
        choices: ["A", "B"],
        answer: "A",
        explanation: "A is correct.",
      }],
      revision: 1,
      generationRunId,
    });
    await db.insert(cards).values({
      id: cardId,
      reviewerId,
      sourceKey: "c1",
      front: "Front",
      back: "Back",
    });
  }, 60_000);

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
  }, 60_000);

  it("inserts an attempt with snake_case JSON fields and returns stats", async () => {
    const result = await recordTestAttempts({
      reviewerId,
      userId,
      expectedRevision: 1,
      answers: [{ itemId: "q1", selectedAnswer: "A" }],
    });

    expect(result).toMatchObject({ stats: [{ itemId: "q1", attempts: 1, misses: 0 }] });
    const rows = await db.select().from(testAttempts).where(eq(testAttempts.reviewerId, reviewerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.selectedAnswer).toBe("A");

    const routeResponse = await attemptsPost(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 1,
          answers: [{ itemId: "q1", selectedAnswer: "B" }],
        }),
      }),
      { params: Promise.resolve({ id: reviewerId }) },
    );
    expect(routeResponse.status).toBe(200);
    expect(await routeResponse.json()).toMatchObject({ stats: [{ itemId: "q1", attempts: 2, misses: 1 }] });
  });

  it("persists timed sessions, resumes progress, and makes same-item writes idempotent", async () => {
    const timedTopicId = randomUUID();
    const timedReviewerId = randomUUID();
    const timedViewId = randomUUID();
    await db.insert(topics).values({ id: timedTopicId, userId, name: "Timed integration" });
    await db.insert(reviewers).values({ id: timedReviewerId, topicId: timedTopicId, name: "Timed integration" });
    await db.insert(views).values({
      id: timedViewId,
      reviewerId: timedReviewerId,
      kind: "test_me",
      revision: 1,
      content: JSON.stringify([
        { id: "q1", question: "Q1", choices: ["A", "B"], answer: "A", explanation: "" },
        { id: "q2", question: "Q2", choices: ["C", "D"], answer: "C", explanation: "" },
        { id: "q3", question: "Q3", choices: ["E", "F"], answer: "E", explanation: "" },
      ]),
      contentJson: [
        { id: "q1", question: "Q1", choices: ["A", "B"], answer: "A", explanation: "" },
        { id: "q2", question: "Q2", choices: ["C", "D"], answer: "C", explanation: "" },
        { id: "q3", question: "Q3", choices: ["E", "F"], answer: "E", explanation: "" },
      ],
    });

    const first = await createOrResumeTimedTestSession({
      userId,
      reviewerId: timedReviewerId,
      expectedRevision: 1,
      durationSeconds: 60,
    });
    expect(first).toMatchObject({ status: "active", answeredItemIds: [] });
    if (!first) throw new Error("timed session was not created");
    const resumed = await createOrResumeTimedTestSession({
      userId,
      reviewerId: timedReviewerId,
      expectedRevision: 1,
      durationSeconds: 60,
    });
    expect(resumed?.id).toBe(first.id);
    expect(resumed?.startedAt).toEqual(first.startedAt);

    const sameAnswer = await Promise.all([
      recordTimedTestAttempt({
        userId,
        reviewerId: timedReviewerId,
        sessionId: first.id,
        expectedRevision: 1,
        itemId: "q1",
        selectedAnswer: "A",
      }),
      recordTimedTestAttempt({
        userId,
        reviewerId: timedReviewerId,
        sessionId: first.id,
        expectedRevision: 1,
        itemId: "q1",
        selectedAnswer: "A",
      }),
    ]);
    expect(sameAnswer.every((result) => "stats" in result || "conflict" in result)).toBe(true);
    const persisted = await db
      .select()
      .from(testAttempts)
      .where(eq(testAttempts.sessionId, first.id));
    expect(persisted).toHaveLength(1);

    const afterAnswer = await getActiveTimedTestSession({
      userId,
      reviewerId: timedReviewerId,
      expectedRevision: 1,
    });
    expect(afterAnswer?.answeredItemIds).toEqual(["q1"]);
    const [progressAfterFirst] = await db
      .select({ answeredCount: testSessions.answeredCount })
      .from(testSessions)
      .where(eq(testSessions.id, first.id));
    expect(progressAfterFirst?.answeredCount).toBe(1);

    const differentAnswer = await recordTimedTestAttempt({
      userId,
      reviewerId: timedReviewerId,
      sessionId: first.id,
      expectedRevision: 1,
      itemId: "q1",
      selectedAnswer: "B",
    });
    expect(differentAnswer).toEqual({ conflict: true });

    // These are two different final items racing from the same one-answer
    // state. The counter must advance once per unique item, and both
    // successful inserts must remain visible as the session completes.
    const finalAnswers = await Promise.all([
      recordTimedTestAttempt({
        userId,
        reviewerId: timedReviewerId,
        sessionId: first.id,
        expectedRevision: 1,
        itemId: "q2",
        selectedAnswer: "C",
      }),
      recordTimedTestAttempt({
        userId,
        reviewerId: timedReviewerId,
        sessionId: first.id,
        expectedRevision: 1,
        itemId: "q3",
        selectedAnswer: "E",
      }),
    ]);
    expect(finalAnswers).toHaveLength(2);
    expect(finalAnswers.filter((result) => "stats" in result)).toHaveLength(2);
    expect(finalAnswers.some((result) => "completed" in result && result.completed)).toBe(true);
    const [completedSession] = await db
      .select({
        status: testSessions.status,
        answeredCount: testSessions.answeredCount,
        completedAt: testSessions.completedAt,
      })
      .from(testSessions)
      .where(eq(testSessions.id, first.id));
    expect(completedSession?.status).toBe("completed");
    expect(completedSession?.answeredCount).toBe(3);
    expect(completedSession?.completedAt).toBeInstanceOf(Date);

    // Replaying the completed item from many tabs must always be an explicit
    // idempotent success, never a missing session/attempt result.
    const replayFinal = await Promise.all(Array.from({ length: 20 }, () =>
      recordTimedTestAttempt({
        userId,
        reviewerId: timedReviewerId,
        sessionId: first.id,
        expectedRevision: 1,
        itemId: "q3",
        selectedAnswer: "E",
      }),
    ));
    expect(replayFinal.every((result) =>
      "stats" in result && result.alreadySaved === true && result.completed === true,
    )).toBe(true);
    expect(await getActiveTimedTestSession({
      userId,
      reviewerId: timedReviewerId,
      expectedRevision: 1,
    })).toBeNull();

    const restarted = await createOrResumeTimedTestSession({
      userId,
      reviewerId: timedReviewerId,
      expectedRevision: 1,
      durationSeconds: 60,
    });
    expect(restarted?.id).not.toBe(first.id);
    expect(restarted?.answeredItemIds).toEqual([]);
    if (!restarted) throw new Error("timed session was not restarted");

    await db
      .update(testSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(testSessions.id, restarted.id));
    await expect(recordTimedTestAttempt({
      userId,
      reviewerId: timedReviewerId,
      sessionId: restarted.id,
      expectedRevision: 1,
      itemId: "q2",
      selectedAnswer: "C",
    })).resolves.toEqual({ expired: true });
    await db.delete(topics).where(eq(topics.id, timedTopicId));
  }, 30_000);

  it("reports completion from the atomic counter for a two-item session", async () => {
    const timedTopicId = randomUUID();
    const timedReviewerId = randomUUID();
    const timedViewId = randomUUID();
    const itemRows = [
      { id: "q1", question: "Q1", choices: ["A", "B"], answer: "A", explanation: "" },
      { id: "q2", question: "Q2", choices: ["C", "D"], answer: "C", explanation: "" },
    ];
    await db.insert(topics).values({ id: timedTopicId, userId, name: "Timed two-item integration" });
    await db.insert(reviewers).values({ id: timedReviewerId, topicId: timedTopicId, name: "Timed two-item integration" });
    await db.insert(views).values({
      id: timedViewId,
      reviewerId: timedReviewerId,
      kind: "test_me",
      revision: 1,
      content: JSON.stringify(itemRows),
      contentJson: itemRows,
    });

    const session = await createOrResumeTimedTestSession({
      userId,
      reviewerId: timedReviewerId,
      expectedRevision: 1,
      durationSeconds: 60,
    });
    if (!session) throw new Error("two-item timed session was not created");

    const first = await recordTimedTestAttempt({
      userId,
      reviewerId: timedReviewerId,
      sessionId: session.id,
      expectedRevision: 1,
      itemId: "q1",
      selectedAnswer: "A",
    });
    expect(first).toMatchObject({ alreadySaved: false, completed: false });

    const duplicateActive = await recordTimedTestAttempt({
      userId,
      reviewerId: timedReviewerId,
      sessionId: session.id,
      expectedRevision: 1,
      itemId: "q1",
      selectedAnswer: "A",
    });
    expect(duplicateActive).toMatchObject({ alreadySaved: true, completed: false });

    const final = await recordTimedTestAttempt({
      userId,
      reviewerId: timedReviewerId,
      sessionId: session.id,
      expectedRevision: 1,
      itemId: "q2",
      selectedAnswer: "C",
    });
    expect(final).toMatchObject({ alreadySaved: false, completed: true });

    const completedReplay = await recordTimedTestAttempt({
      userId,
      reviewerId: timedReviewerId,
      sessionId: session.id,
      expectedRevision: 1,
      itemId: "q2",
      selectedAnswer: "C",
    });
    expect(completedReplay).toMatchObject({ alreadySaved: true, completed: true });

    const [persisted] = await db
      .select({ status: testSessions.status, answeredCount: testSessions.answeredCount })
      .from(testSessions)
      .where(eq(testSessions.id, session.id));
    expect(persisted).toEqual({ status: "completed", answeredCount: 2 });
    await db.delete(topics).where(eq(topics.id, timedTopicId));
  }, 30_000);

  it("returns date objects after atomic card review and inserts history", async () => {
    const result = await reviewCard({
      reviewerId,
      userId,
      cardId,
      expectedRevision: 1,
      rating: "good",
    });

    expect(result).not.toMatchObject({ stale: true });
    if (!result || "stale" in result) throw new Error("card review did not update");
    expect(result.dueAt).toBeInstanceOf(Date);
    expect(serializeCard(result).dueAt).toMatch(/T/);
    const rows = await db.select().from(cardReviews).where(eq(cardReviews.cardId, cardId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rating).toBe("good");

    const routeResponse = await reviewPost(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 2, rating: "good" }),
      }),
      { params: Promise.resolve({ id: reviewerId, cardId }) },
    );
    expect(routeResponse.status).toBe(200);
    expect(await routeResponse.json()).toMatchObject({ card: { id: cardId, dueAt: expect.stringContaining("T") } });
  });

  it("enforces tenant ownership and revision CAS under concurrent writes", async () => {
    await expect(getReviewer(reviewerId, randomUUID())).resolves.toBeNull();

    const viewWrites = await Promise.all([
      updateStudyView({
        reviewerId,
        userId,
        kind: "test_me",
        expectedRevision: 1,
        pinned: true,
      }),
      updateStudyView({
        reviewerId,
        userId,
        kind: "test_me",
        expectedRevision: 1,
        content: JSON.stringify([{ id: "q1", question: "Changed", answer: "A", explanation: "" }]),
      }),
    ]);
    expect(viewWrites.filter((row) => row && !("stale" in row))).toHaveLength(1);
    expect(viewWrites.filter((row) => row && "stale" in row)).toHaveLength(1);

    const staleAttempt = await recordTestAttempts({
      reviewerId,
      userId,
      expectedRevision: 1,
      answers: [{ itemId: "q1", selectedAnswer: "A" }],
    });
    expect(staleAttempt).toEqual({ stale: true });

    const cardWrites = await Promise.all([
      reviewCard({ reviewerId, userId, cardId, expectedRevision: 3, rating: "again" }),
      reviewCard({ reviewerId, userId, cardId, expectedRevision: 3, rating: "good" }),
    ]);
    expect(cardWrites.filter((row) => row && !("stale" in row))).toHaveLength(1);
    expect(cardWrites.filter((row) => row && "stale" in row)).toHaveLength(1);
    const history = await db.select().from(cardReviews).where(eq(cardReviews.cardId, cardId));
    expect(history).toHaveLength(3);
  });

  it("blocks source registration behind reviewer and topic deletion tombstones", async () => {
    const reviewerSource = {
      reviewerId,
      filename: "blocked.txt",
      mime: "text/plain",
      kind: "text" as const,
      blobUrl: null,
      blobPathname: null,
      ingestStatus: "ready" as const,
      extractedText: "blocked",
      errorMessage: null,
    };

    expect(await beginReviewerDeletion(reviewerId, userId)).toBe(true);
    await expect(createSourceForOwner(userId, reviewerSource)).rejects.toThrow(
      /being deleted/i,
    );
    expect(await beginReviewerDeletion(reviewerId, userId)).toBe(false);

    // The marker remains durable after the failed registration attempt; the
    // enclosing user cleanup removes this fixture and its tombstone.
    const markedReviewer = await db
      .select({ deletingAt: reviewers.deletingAt })
      .from(reviewers)
      .where(eq(reviewers.id, reviewerId));
    expect(markedReviewer[0]?.deletingAt).toBeInstanceOf(Date);

    // Topic-level deletion uses the same lock/check contract. Use a fresh
    // topic/reviewer so the reviewer tombstone above remains observable.
    const topic2 = randomUUID();
    const reviewer2 = randomUUID();
    await db.insert(topics).values({ id: topic2, userId, name: "Topic tombstone" });
    await db.insert(reviewers).values({ id: reviewer2, topicId: topic2, name: "Reviewer tombstone" });
    expect(await beginTopicDeletion(topic2, userId)).toBe(true);
    await expect(createSourceForOwner(userId, { ...reviewerSource, reviewerId: reviewer2 })).rejects.toThrow(
      /being deleted/i,
    );
  }, 30_000);

  it("serializes Blob reservations, makes source registration idempotent, and protects deletion", async () => {
    const topic3 = randomUUID();
    const reviewer3 = randomUUID();
    const pathname = `users/${userId}/reviewers/${reviewer3}/${randomUUID()}-notes.txt`;
    const firstAttemptToken = randomUUID();
    const competingAttemptToken = randomUUID();
    await db.insert(topics).values({ id: topic3, userId, name: "Blob reservation" });
    await db.insert(reviewers).values({ id: reviewer3, topicId: topic3, name: "Blob reservation" });

    const reservations = await Promise.all([
      reserveBlobForRegistration(
        userId,
        reviewer3,
        pathname,
        firstAttemptToken,
        undefined,
        { allowTokenCreation: true },
      ),
      reserveBlobForRegistration(userId, reviewer3, pathname, competingAttemptToken),
    ]);
    expect(reservations.map((row) => row.outcome).sort()).toContain("reserved");
    expect(reservations.some((row) => row.outcome === "busy" || row.outcome === "conflict")).toBe(true);
    const reservation = reservations.find((row) => row.outcome === "reserved");
    if (!reservation || reservation.outcome !== "reserved") {
      throw new Error("reservation attempt did not win");
    }
    const sameAttemptRegistration = await reserveBlobForRegistration(
      userId,
      reviewer3,
      pathname,
      reservation.attemptToken,
    );
    expect(sameAttemptRegistration).toMatchObject({
      outcome: "reserved",
      attemptToken: reservation.attemptToken,
    });

    const replayedOnOtherPath = await reserveBlobForRegistration(
      userId,
      reviewer3,
      `users/${userId}/reviewers/${reviewer3}/${randomUUID()}-other.txt`,
      reservation.attemptToken,
    );
    expect(replayedOnOtherPath.outcome).toBe("conflict");

    const source = await createSourceForOwner(userId, {
      reviewerId: reviewer3,
      filename: "notes.txt",
      mime: "text/plain",
      kind: "text",
      blobUrl: `https://store.private.blob.vercel-storage.com/${pathname}`,
      blobPathname: pathname,
      ingestStatus: "ready",
      extractedText: "one source",
      errorMessage: null,
    }, reservation.attemptToken);
    const retry = await createSourceForOwner(userId, {
      reviewerId: reviewer3,
      filename: "different-name.txt",
      mime: "text/plain",
      kind: "text",
      blobUrl: `https://store.private.blob.vercel-storage.com/${pathname}`,
      blobPathname: pathname,
      ingestStatus: "ready",
      extractedText: "must not overwrite",
      errorMessage: null,
    }, reservation.attemptToken);
    expect(retry.id).toBe(source.id);
    expect(retry.extractedText).toBe("one source");
    await expect(db.insert(sources).values({
      id: randomUUID(),
      reviewerId: reviewer3,
      filename: "duplicate.txt",
      mime: "text/plain",
      kind: "text",
      blobUrl: `https://store.private.blob.vercel-storage.com/${pathname}`,
      blobPathname: pathname,
      ingestStatus: "ready",
      extractedText: "duplicate",
      errorMessage: null,
    })).rejects.toThrow();

    // A live source reference cannot be deleted by reconciliation. A source
    // deletion claim must be explicit and leaves the row retryable.
    await expect(claimBlobDeletion(userId, reviewer3, pathname, false)).resolves.toBe(null);
    await expect(beginSourceDeletion(source.id, reviewer3, userId)).resolves.toMatchObject({
      id: source.id,
      deletingAt: expect.any(Date),
    });
    await expect(claimBlobDeletion(userId, reviewer3, pathname, false)).resolves.toBe(null);
    const deletionClaim = await claimBlobDeletion(userId, reviewer3, pathname, true);
    expect(deletionClaim).toMatchObject({ attemptToken: expect.any(String) });
    await expect(deleteSourceForOwner(source.id, reviewer3, userId)).resolves.toMatchObject({ id: source.id });
  }, 30_000);

  it("keeps an orphan deletion claim durable until the exact attempt completes", async () => {
    const topic4 = randomUUID();
    const reviewer4 = randomUUID();
    const pathname = `users/${userId}/reviewers/${reviewer4}/${randomUUID()}-orphan.txt`;
    await db.insert(topics).values({ id: topic4, userId, name: "Orphan reservation" });
    await db.insert(reviewers).values({ id: reviewer4, topicId: topic4, name: "Orphan reservation" });

    const deletionClaim = await claimBlobDeletion(userId, reviewer4, pathname, false);
    expect(deletionClaim).toMatchObject({ attemptToken: expect.any(String) });
    if (!deletionClaim) throw new Error("orphan deletion was not claimed");

    // The live deleting lease blocks a different upload attempt. A stale
    // cleanup token cannot release or complete this replacement claim.
    const competing = await reserveBlobForRegistration(
      userId,
      reviewer4,
      pathname,
      randomUUID(),
    );
    expect(competing.outcome).toBe("conflict");

    await expect(releaseBlobReservation(userId, reviewer4, pathname, randomUUID())).resolves.toBe(false);
    await requeueBlobDeletion(userId, reviewer4, pathname, randomUUID());
    const stillBusy = await reserveBlobForRegistration(userId, reviewer4, pathname, randomUUID());
    expect(stillBusy.outcome).toBe("conflict");

    // Once the old lease expires, a replacement may take over. Delayed
    // cleanup from the old attempt must not release or delete that replacement.
    await db.execute(sql`
      UPDATE blob_reservations
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE pathname = ${pathname}
    `);
    const replacementToken = randomUUID();
    const replacement = await reserveBlobForRegistration(
      userId,
      reviewer4,
      pathname,
      replacementToken,
      undefined,
      { allowTokenCreation: true },
    );
    expect(replacement).toMatchObject({ outcome: "reserved", attemptToken: replacementToken });
    await requeueBlobDeletion(userId, reviewer4, pathname, deletionClaim.attemptToken);
    await completeBlobDeletion(userId, reviewer4, pathname, deletionClaim.attemptToken);
    const current = await db
      .select({ attemptToken: blobReservations.attemptToken, state: blobReservations.state })
      .from(blobReservations)
      .where(eq(blobReservations.pathname, pathname));
    expect(current).toEqual([{ attemptToken: replacementToken, state: "reserved" }]);
    await releaseBlobReservation(userId, reviewer4, pathname, replacementToken);
  }, 30_000);
});
