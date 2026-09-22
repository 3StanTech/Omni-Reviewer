import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authMock = vi.hoisted(() => vi.fn());
const getReviewerMock = vi.hoisted(() => vi.fn());
const getViewMock = vi.hoisted(() => vi.fn());
const recordMock = vi.hoisted(() => vi.fn());
const recordTimedMock = vi.hoisted(() => vi.fn());
const recordUntimedMock = vi.hoisted(() => vi.fn());
const statsMock = vi.hoisted(() => vi.fn());
const createSessionMock = vi.hoisted(() => vi.fn());
const activeSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/queries", () => ({
  getReviewer: getReviewerMock,
  getViewForReviewer: getViewMock,
  recordTestAttempts: recordMock,
  recordTimedTestAttempt: recordTimedMock,
  recordUntimedTestAttempt: recordUntimedMock,
  listTestAttemptStats: statsMock,
  createOrResumeTimedTestSession: createSessionMock,
  getActiveTimedTestSession: activeSessionMock,
}));

import { POST as attemptsPost } from "@/app/api/reviewers/[id]/test-attempts/route";
import {
  GET as sessionGet,
  POST as sessionPost,
} from "@/app/api/reviewers/[id]/test-attempts/session/route";
import { createTimedTestSession, verifyTimedTestSession } from "@/lib/test-timing";

function request(body: unknown): Request {
  return new Request("https://omni-reviewer.example", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("timed Test Me route contracts", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "route-test-secret-0123456789abcdefgh";
    authMock.mockReset();
    getReviewerMock.mockReset();
    getViewMock.mockReset();
    recordMock.mockReset();
    recordTimedMock.mockReset();
    recordUntimedMock.mockReset();
    statsMock.mockReset();
    createSessionMock.mockReset();
    activeSessionMock.mockReset();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewerMock.mockResolvedValue({ id: "reviewer-1" });
    getViewMock.mockResolvedValue({ revision: 2 });
    recordMock.mockResolvedValue({ stats: [] });
    recordTimedMock.mockResolvedValue({ stats: [], alreadySaved: false, completed: false });
    createSessionMock.mockResolvedValue({
      id: "session-000000000000001",
      userId: "user-1",
      reviewerId: "reviewer-1",
      viewRevision: 2,
      startedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 59_000),
      status: "active",
      completedAt: null,
      answeredCount: 0,
      answeredItemIds: [],
    });
  });

  it("issues a revision-bound server deadline", async () => {
    const response = await sessionPost(
      request({ expectedRevision: 2, durationSeconds: 60 }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { sessionToken: string; expiresAt: string };
    expect(body.sessionToken).toBeTruthy();
    expect(body.expiresAt).toContain("T");
    expect(verifyTimedTestSession(body.sessionToken).ok).toBe(true);
  });

  it("rejects a stale start and preserves the legacy bulk request shape", async () => {
    getViewMock.mockResolvedValue({ revision: 3 });
    const stale = await sessionPost(
      request({ expectedRevision: 2, durationSeconds: 60 }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(stale.status).toBe(409);

    const legacy = await attemptsPost(
      request({ expectedRevision: 2, answers: [{ itemId: "q1", selectedAnswer: "A" }] }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(legacy.status).toBe(200);
    expect(recordMock).toHaveBeenCalledWith({
      reviewerId: "reviewer-1",
      userId: "user-1",
      expectedRevision: 2,
      answers: [{ itemId: "q1", selectedAnswer: "A" }],
    });
  });

  it("resumes an active persisted session with its answered item ids", async () => {
    activeSessionMock.mockResolvedValue({
      id: "session-000000000000001",
      userId: "user-1",
      reviewerId: "reviewer-1",
      viewRevision: 2,
      startedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 59_000),
      status: "active",
      completedAt: null,
      answeredCount: 1,
      answeredItemIds: ["q1"],
    });
    const response = await sessionGet(
      new Request("https://omni-reviewer.example/api/reviewers/reviewer-1/test-attempts/session?expectedRevision=2"),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ answeredItemIds: ["q1"] });
  });

  it("returns a successful empty sentinel when no session exists yet", async () => {
    activeSessionMock.mockResolvedValue(null);
    const response = await sessionGet(
      new Request("https://omni-reviewer.example/api/reviewers/reviewer-1/test-attempts/session?expectedRevision=2"),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ session: null });
  });

  it("accepts one signed timed answer only for the signed owner and revision", async () => {
    const session = createTimedTestSession({
      userId: "user-1",
      reviewerId: "reviewer-1",
      viewRevision: 2,
      durationSeconds: 60,
    });
    const response = await attemptsPost(
      request({
        mode: "timed",
        sessionToken: session.token,
        expectedRevision: 2,
        itemId: "q1",
        selectedAnswer: "A",
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(response.status).toBe(200);
    expect(recordTimedMock).toHaveBeenCalledWith({
      reviewerId: "reviewer-1",
      userId: "user-1",
      sessionId: session.sessionId,
      expectedRevision: 2,
      itemId: "q1",
      selectedAnswer: "A",
    });

    const wrongOwner = createTimedTestSession({
      userId: "other-user",
      reviewerId: "reviewer-1",
      viewRevision: 2,
      durationSeconds: 60,
    });
    const rejected = await attemptsPost(
      request({ mode: "timed", sessionToken: wrongOwner.token, expectedRevision: 2, itemId: "q1", selectedAnswer: "A" }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );
    expect(rejected.status).toBe(409);
    expect(recordTimedMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the server completion bit for first, duplicate, final, and replay answers", async () => {
    const session = createTimedTestSession({
      userId: "user-1",
      reviewerId: "reviewer-1",
      viewRevision: 2,
      durationSeconds: 60,
    });
    const cases = [
      { stats: [], alreadySaved: false, completed: false },
      { stats: [], alreadySaved: true, completed: false },
      { stats: [], alreadySaved: false, completed: true },
      { stats: [], alreadySaved: true, completed: true },
    ] as const;

    for (const result of cases) {
      recordTimedMock.mockResolvedValueOnce(result);
      const response = await attemptsPost(
        request({
          mode: "timed",
          sessionToken: session.token,
          expectedRevision: 2,
          itemId: "q1",
          selectedAnswer: "A",
        }),
        { params: Promise.resolve({ id: "reviewer-1" }) },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(result);
    }
  });
});
