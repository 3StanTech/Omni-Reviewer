import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const deleteBlobMock = vi.fn();
const beginReviewerDeletionMock = vi.fn();
const deleteReviewerMock = vi.fn();
const getReviewerMock = vi.fn();
const listSourcesByReviewerMock = vi.fn();
const beginTopicDeletionMock = vi.fn();
const deleteTopicMock = vi.fn();
const getTopicMock = vi.fn();
const listReviewersByTopicMock = vi.fn();

vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));
vi.mock("@/lib/blob", () => ({
  deleteBlobIfUnreferenced: (...args: unknown[]) => deleteBlobMock(...args),
}));
vi.mock("@/lib/queries", () => ({
  beginReviewerDeletion: (...args: unknown[]) => beginReviewerDeletionMock(...args),
  beginTopicDeletion: (...args: unknown[]) => beginTopicDeletionMock(...args),
  deleteReviewer: (...args: unknown[]) => deleteReviewerMock(...args),
  deleteTopic: (...args: unknown[]) => deleteTopicMock(...args),
  getReviewer: (...args: unknown[]) => getReviewerMock(...args),
  getTopic: (...args: unknown[]) => getTopicMock(...args),
  listBlobReservationsForReviewer: vi.fn().mockResolvedValue([]),
  listReviewersByTopic: (...args: unknown[]) => listReviewersByTopicMock(...args),
  listSourcesByReviewer: (...args: unknown[]) => listSourcesByReviewerMock(...args),
  markSourcesDeletingForReviewer: vi.fn().mockResolvedValue(undefined),
  markSourcesDeletingForTopic: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/public-errors", () => ({ logRedactedError: vi.fn() }));

import { DELETE as deleteReviewerRoute } from "@/app/api/reviewers/[id]/route";
import { DELETE as deleteTopicRoute } from "@/app/api/topics/[id]/route";

const reviewerContext = { params: Promise.resolve({ id: "reviewer-1" }) };
const topicContext = { params: Promise.resolve({ id: "topic-1" }) };

describe("source deletion coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    beginReviewerDeletionMock.mockResolvedValue(true);
    beginTopicDeletionMock.mockResolvedValue(true);
    getReviewerMock.mockResolvedValue({ id: "reviewer-1" });
    getTopicMock.mockResolvedValue({ id: "topic-1" });
    deleteReviewerMock.mockResolvedValue({ id: "reviewer-1" });
    deleteTopicMock.mockResolvedValue({ id: "topic-1" });
    deleteBlobMock.mockResolvedValue(true);
    listSourcesByReviewerMock.mockResolvedValue([]);
    listReviewersByTopicMock.mockResolvedValue([]);
  });

  it("marks a reviewer before cleanup and skips nullable paste blobs", async () => {
    const events: string[] = [];
    beginReviewerDeletionMock.mockImplementation(async () => {
      events.push("mark");
      return true;
    });
    listSourcesByReviewerMock.mockImplementation(async () => {
      events.push("list");
      return [
        { reviewerId: "reviewer-1", blobPathname: null, kind: "paste" },
        {
          reviewerId: "reviewer-1",
          blobPathname: "users/user-1/reviewers/reviewer-1/file.txt",
          kind: "text",
        },
      ];
    });
    deleteBlobMock.mockImplementation(async () => {
      events.push("blob");
      return true;
    });
    deleteReviewerMock.mockImplementation(async () => {
      events.push("row");
      return { id: "reviewer-1" };
    });

    const response = await deleteReviewerRoute(new Request("https://example.test"), reviewerContext);

    expect(response.status).toBe(200);
    expect(events).toEqual(["mark", "list", "blob", "row"]);
    expect(deleteBlobMock).toHaveBeenCalledTimes(1);
    expect(deleteBlobMock).toHaveBeenCalledWith(
      "users/user-1/reviewers/reviewer-1/file.txt",
      { userId: "user-1", reviewerId: "reviewer-1" },
      expect.objectContaining({
        allowDeletingSource: true,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("retains the reviewer tombstone when external cleanup fails", async () => {
    listSourcesByReviewerMock.mockResolvedValue([
      { reviewerId: "reviewer-1", blobPathname: "users/user-1/reviewers/reviewer-1/file.txt" },
    ]);
    deleteBlobMock.mockResolvedValue(false);

    const response = await deleteReviewerRoute(new Request("https://example.test"), reviewerContext);

    expect(response.status).toBe(503);
    expect(deleteReviewerMock).not.toHaveBeenCalled();
  });

  it("marks a topic before fan-out cleanup and excludes paste rows", async () => {
    const events: string[] = [];
    beginTopicDeletionMock.mockImplementation(async () => {
      events.push("mark");
      return true;
    });
    listReviewersByTopicMock.mockImplementation(async () => {
      events.push("reviewers");
      return [{ id: "reviewer-1" }, { id: "reviewer-2" }];
    });
    listSourcesByReviewerMock
      .mockImplementationOnce(async () => {
        events.push("list-1");
        return [{ reviewerId: "reviewer-1", blobPathname: null, kind: "paste" }];
      })
      .mockImplementationOnce(async () => {
        events.push("list-2");
        return [{
          reviewerId: "reviewer-2",
          blobPathname: "users/user-1/reviewers/reviewer-2/file.txt",
          kind: "text",
        }];
      });
    deleteBlobMock.mockImplementation(async () => {
      events.push("blob");
      return true;
    });
    deleteTopicMock.mockImplementation(async () => {
      events.push("row");
      return { id: "topic-1" };
    });

    const response = await deleteTopicRoute(new Request("https://example.test"), topicContext);

    expect(response.status).toBe(200);
    expect(events).toEqual(["mark", "reviewers", "list-1", "list-2", "blob", "row"]);
    expect(deleteBlobMock).toHaveBeenCalledTimes(1);
    expect(deleteBlobMock).toHaveBeenCalledWith(
      "users/user-1/reviewers/reviewer-2/file.txt",
      { userId: "user-1", reviewerId: "reviewer-2" },
      expect.objectContaining({
        allowDeletingSource: true,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("retains the topic tombstone when one source cleanup fails", async () => {
    listReviewersByTopicMock.mockResolvedValue([{ id: "reviewer-1" }]);
    listSourcesByReviewerMock.mockResolvedValue([
      { reviewerId: "reviewer-1", blobPathname: "users/user-1/reviewers/reviewer-1/file.txt" },
    ]);
    deleteBlobMock.mockResolvedValue(false);

    const response = await deleteTopicRoute(new Request("https://example.test"), topicContext);

    expect(response.status).toBe(503);
    expect(deleteTopicMock).not.toHaveBeenCalled();
  });
});
