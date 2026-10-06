import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authMock = vi.hoisted(() => vi.fn());
const getReviewer = vi.hoisted(() => vi.fn());
const setReviewerQueued = vi.hoisted(() => vi.fn());
const listQueuedPacks = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/queries", () => ({ getReviewer, setReviewerQueued, listQueuedPacks }));

import { GET } from "@/app/api/queue/route";
import { PUT } from "@/app/api/reviewers/[id]/queue/route";

const context = { params: Promise.resolve({ id: "reviewer-1" }) };

function putRequest(body: unknown): Request {
  return new Request("http://127.0.0.1:3000/api/reviewers/reviewer-1/queue", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("queue routes", () => {
  beforeEach(() => {
    authMock.mockReset();
    getReviewer.mockReset();
    setReviewerQueued.mockReset();
    listQueuedPacks.mockReset();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1", deletingAt: null });
  });

  it("requires a session for both routes", async () => {
    authMock.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(putRequest({ queued: true }), context)).status).toBe(401);
    expect(listQueuedPacks).not.toHaveBeenCalled();
    expect(setReviewerQueued).not.toHaveBeenCalled();
  });

  it("returns 404 for another owner's pack without writing", async () => {
    getReviewer.mockResolvedValue(null);
    const response = await PUT(putRequest({ queued: true }), context);
    expect(response.status).toBe(404);
    expect(getReviewer).toHaveBeenCalledWith("reviewer-1", "user-1");
    expect(setReviewerQueued).not.toHaveBeenCalled();
  });

  it("returns 404 for a pack being deleted", async () => {
    getReviewer.mockResolvedValue({ id: "reviewer-1", deletingAt: new Date() });
    expect((await PUT(putRequest({ queued: true }), context)).status).toBe(404);
    expect(setReviewerQueued).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown key", { queued: true, extra: 1 }],
    ["a non-boolean flag", { queued: "yes" }],
    ["a missing flag", {}],
    ["a non-boolean requeue", { queued: true, requeue: "yes" }],
  ])("rejects %s", async (_label, body) => {
    expect((await PUT(putRequest(body), context)).status).toBe(400);
    expect(setReviewerQueued).not.toHaveBeenCalled();
  });

  it("rejects an oversized body", async () => {
    const response = await PUT(putRequest(JSON.stringify({ queued: true, pad: "x".repeat(1_100_000) })), context);
    expect(response.status).toBe(413);
    expect(setReviewerQueued).not.toHaveBeenCalled();
  });

  it("sets and clears the queue flag for the owner", async () => {
    const queuedAt = new Date("2026-10-06T01:00:00.000Z");
    setReviewerQueued.mockResolvedValueOnce({ queuedAt });
    const set = await PUT(putRequest({ queued: true }), context);
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ queuedAt: queuedAt.toISOString() });
    expect(setReviewerQueued).toHaveBeenLastCalledWith("reviewer-1", "user-1", true, false);

    setReviewerQueued.mockResolvedValueOnce({ queuedAt: null });
    const cleared = await PUT(putRequest({ queued: false }), context);
    expect(await cleared.json()).toEqual({ queuedAt: null });
    expect(setReviewerQueued).toHaveBeenLastCalledWith("reviewer-1", "user-1", false, false);
  });

  it("stamps a new queue time only for a Retry requeue", async () => {
    setReviewerQueued.mockResolvedValue({ queuedAt: new Date("2026-10-06T03:00:00.000Z") });
    await PUT(putRequest({ queued: true, requeue: true }), context);
    expect(setReviewerQueued).toHaveBeenLastCalledWith("reviewer-1", "user-1", true, true);
    await PUT(putRequest({ queued: false, requeue: true }), context);
    expect(setReviewerQueued).toHaveBeenLastCalledWith("reviewer-1", "user-1", false, false);
  });

  it("lists only the caller's queue, in order, with readiness and no caching", async () => {
    listQueuedPacks.mockResolvedValue([
      {
        id: "a",
        topicId: "t",
        name: "Trans 5",
        queuedAt: new Date("2026-10-06T01:00:00.000Z"),
        ready: true,
        activeJobId: "job-a",
        failed: false,
        lastError: null,
      },
      {
        id: "b",
        topicId: "t",
        name: "Scanned",
        queuedAt: new Date("2026-10-06T02:00:00.000Z"),
        ready: false,
        activeJobId: null,
        failed: false,
        lastError: null,
      },
      {
        id: "c",
        topicId: "t",
        name: "Stopped",
        queuedAt: new Date("2026-10-06T03:00:00.000Z"),
        ready: true,
        activeJobId: null,
        failed: true,
        lastError: "Free requests ran out.",
      },
    ]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(listQueuedPacks).toHaveBeenCalledWith("user-1");
    const body = await response.json();
    expect(body.packs.map((p: { id: string }) => p.id)).toEqual(["a", "b", "c"]);
    expect(body.packs[0]).toEqual({
      id: "a",
      topicId: "t",
      name: "Trans 5",
      queuedAt: "2026-10-06T01:00:00.000Z",
      ready: true,
      reason: null,
      activeJobId: "job-a",
      failed: false,
      lastError: null,
    });
    expect(body.packs[2]).toMatchObject({ failed: true, lastError: "Free requests ran out." });
    expect(body.packs[1]).toMatchObject({ ready: false, reason: "no_ready_source" });
  });
});
