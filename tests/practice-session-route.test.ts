import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authMock = vi.hoisted(() => vi.fn());
const getReviewerMock = vi.hoisted(() => vi.fn());
const getViewMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const createSessionMock = vi.hoisted(() => vi.fn());
const restartSessionMock = vi.hoisted(() => vi.fn());
const retryMissedMock = vi.hoisted(() => vi.fn());
const recordUntimedMock = vi.hoisted(() => vi.fn());
const recordMock = vi.hoisted(() => vi.fn());
const recordTimedMock = vi.hoisted(() => vi.fn());
const statsMock = vi.hoisted(() => vi.fn());
const reviewCardMock = vi.hoisted(() => vi.fn());
const serializeCardMock = vi.hoisted(() => vi.fn((card: unknown) => card));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/queries", () => ({
  getReviewer: getReviewerMock,
  getViewForReviewer: getViewMock,
  getUntimedPracticeSession: getSessionMock,
  createOrResumeUntimedPracticeSession: createSessionMock,
  restartUntimedPracticeSession: restartSessionMock,
  retryMissedUntimedPracticeSession: retryMissedMock,
  recordUntimedTestAttempt: recordUntimedMock,
  recordTestAttempts: recordMock,
  recordTimedTestAttempt: recordTimedMock,
  listTestAttemptStats: statsMock,
  reviewCard: reviewCardMock,
  serializeCard: serializeCardMock,
}));

import {
  GET as practiceGet,
  POST as practicePost,
} from "@/app/api/reviewers/[id]/practice-session/route";
import { POST as attemptsPost } from "@/app/api/reviewers/[id]/test-attempts/route";
import { POST as reviewPost } from "@/app/api/reviewers/[id]/cards/[cardId]/review/route";

function jsonRequest(body: unknown): Request {
  return new Request("https://omni-reviewer.example", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const activeSession = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "user-1",
  reviewerId: "reviewer-1",
  viewRevision: 2,
  startedAt: new Date("2026-09-21T00:00:00.000Z"),
  expiresAt: null,
  status: "active" as const,
  completedAt: null,
  answeredCount: 1,
  itemIds: ["q1", "q2"],
  originSessionId: null,
  answers: [{ itemId: "q1", selectedAnswer: "A", correct: true }],
};

const completedSession = {
  ...activeSession,
  status: "completed" as const,
  completedAt: new Date("2026-09-21T00:10:00.000Z"),
  answeredCount: 2,
  answers: [
    { itemId: "q1", selectedAnswer: "A", correct: true },
    { itemId: "q2", selectedAnswer: "B", correct: false },
  ],
};

describe("untimed practice session routes", () => {
  beforeEach(() => {
    authMock.mockReset();
    getReviewerMock.mockReset();
    getViewMock.mockReset();
    getSessionMock.mockReset();
    createSessionMock.mockReset();
    restartSessionMock.mockReset();
    retryMissedMock.mockReset();
    recordUntimedMock.mockReset();
    recordMock.mockReset();
    recordTimedMock.mockReset();
    reviewCardMock.mockReset();
    serializeCardMock.mockReset();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewerMock.mockResolvedValue({ id: "reviewer-1" });
    getViewMock.mockResolvedValue({ revision: 2 });
    serializeCardMock.mockImplementation((card: unknown) => card);
  });

  it("resumes an untimed sitting with accepted answers and the next item", async () => {
    getSessionMock.mockResolvedValue(activeSession);
    const response = await practiceGet(
      new Request("https://omni-reviewer.example/api/reviewers/reviewer-1/practice-session?expectedRevision=2"),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: activeSession.id,
      expiresAt: null,
      itemIds: ["q1", "q2"],
      nextItemId: "q2",
      complete: false,
      correctCount: 1,
    });
  });

  it("returns a successful empty sentinel when no untimed sitting exists", async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await practiceGet(
      new Request("https://omni-reviewer.example/api/reviewers/reviewer-1/practice-session?expectedRevision=2"),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ session: null });
  });

  it("creates a retry-missed sitting from the completed snapshot", async () => {
    retryMissedMock.mockResolvedValue({
      ...activeSession,
      id: "22222222-2222-4222-8222-222222222222",
      itemIds: ["q2"],
      originSessionId: completedSession.id,
      answeredCount: 0,
      answers: [],
    });
    const response = await practicePost(
      jsonRequest({ expectedRevision: 2, intent: "retry_missed", originSessionId: completedSession.id }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      itemIds: ["q2"],
      originSessionId: completedSession.id,
    });
    expect(restartSessionMock).not.toHaveBeenCalled();
  });

  it("reports a conflict when retry missed would replace another sitting", async () => {
    retryMissedMock.mockResolvedValue({ conflict: true });
    const response = await practicePost(
      jsonRequest({ expectedRevision: 2, intent: "retry_missed", originSessionId: completedSession.id }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ conflict: true });
  });

  it("keeps Start again distinct from retry missed", async () => {
    restartSessionMock.mockResolvedValue({
      ...activeSession,
      answers: [],
      answeredCount: 0,
    });
    const response = await practicePost(
      jsonRequest({ expectedRevision: 2, intent: "start_again" }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(200);
    expect(restartSessionMock).toHaveBeenCalledWith({
      userId: "user-1",
      reviewerId: "reviewer-1",
      expectedRevision: 2,
    });
    expect(retryMissedMock).not.toHaveBeenCalled();
  });

  it("rejects an item that is not in the untimed snapshot", async () => {
    recordUntimedMock.mockResolvedValueOnce({ invalid: true });
    const response = await attemptsPost(
      jsonRequest({
        mode: "untimed",
        sessionId: activeSession.id,
        expectedRevision: 2,
        itemId: "q-other",
        selectedAnswer: "A",
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "This question is not part of the current sitting.",
    });
    expect(recordTimedMock).not.toHaveBeenCalled();
  });

  it("saves an untimed answer idempotently and conflicts on a different tab answer", async () => {
    recordUntimedMock.mockResolvedValueOnce({
      stats: [],
      alreadySaved: true,
      completed: false,
      answer: { itemId: "q1", selectedAnswer: "A", correct: true },
    });
    const retry = await attemptsPost(
      jsonRequest({
        mode: "untimed",
        sessionId: activeSession.id,
        expectedRevision: 2,
        itemId: "q1",
        selectedAnswer: "A",
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ alreadySaved: true });

    recordUntimedMock.mockResolvedValueOnce({ conflict: true });
    const conflict = await attemptsPost(
      jsonRequest({
        mode: "untimed",
        sessionId: activeSession.id,
        expectedRevision: 2,
        itemId: "q1",
        selectedAnswer: "B",
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ conflict: true });
    expect(recordTimedMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("invalidates untimed resume when the Test Me revision changed", async () => {
    getViewMock.mockResolvedValue({ revision: 3 });
    const response = await practiceGet(
      new Request("https://omni-reviewer.example/api/reviewers/reviewer-1/practice-session?expectedRevision=2"),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(409);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("replays a lost card rating with the same client request id", async () => {
    reviewCardMock.mockResolvedValue({ id: "card-1", revision: 5, intervalDays: 1 });
    const requestId = "33333333-3333-4333-8333-333333333333";
    const first = await reviewPost(
      jsonRequest({ expectedRevision: 4, rating: "good", clientRequestId: requestId }),
      { params: Promise.resolve({ id: "reviewer-1", cardId: "card-1" }) },
    );
    const retry = await reviewPost(
      jsonRequest({ expectedRevision: 4, rating: "good", clientRequestId: requestId }),
      { params: Promise.resolve({ id: "reviewer-1", cardId: "card-1" }) },
    );
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(reviewCardMock).toHaveBeenCalledTimes(2);
    expect(reviewCardMock).toHaveBeenNthCalledWith(2, {
      reviewerId: "reviewer-1",
      userId: "user-1",
      cardId: "card-1",
      expectedRevision: 4,
      rating: "good",
      clientRequestId: requestId,
    });
  });
});
