import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/blob", () => ({
  deleteBlobIfUnreferenced: vi.fn(),
  getPrivateBlob: vi.fn(),
  MAX_INGEST_BYTES: 50 * 1024 * 1024,
  MAX_UPLOAD_BYTES: 500 * 1024 * 1024,
}));
vi.mock("@/lib/queries", () => ({
  beginSourceDeletion: vi.fn(),
  deleteSourceForOwner: vi.fn(),
  getReviewer: vi.fn(),
  getSourceForReviewer: vi.fn(),
  replaceFailedSourceIngest: vi.fn(),
}));
vi.mock("@/lib/ingest", () => ({
  createIngestBudget: vi.fn(),
  ingestSource: vi.fn(),
}));
vi.mock("@/lib/public-errors", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-errors")>("@/lib/public-errors");
  return { ...actual, logRedactedError: vi.fn() };
});

import { auth } from "@/auth";
import { deleteBlobIfUnreferenced, getPrivateBlob } from "@/lib/blob";
import { createIngestBudget, ingestSource } from "@/lib/ingest";
import { beginSourceDeletion, deleteSourceForOwner, getReviewer, getSourceForReviewer, replaceFailedSourceIngest } from "@/lib/queries";
import { DELETE, GET, POST } from "@/app/api/reviewers/[id]/sources/[sourceId]/route";

const authMock = auth as unknown as ReturnType<typeof vi.fn>;
const reviewerMock = getReviewer as unknown as ReturnType<typeof vi.fn>;
const sourceMock = getSourceForReviewer as unknown as ReturnType<typeof vi.fn>;
const deleteBlobMock = deleteBlobIfUnreferenced as unknown as ReturnType<typeof vi.fn>;
const beginSourceDeletionMock = beginSourceDeletion as unknown as ReturnType<typeof vi.fn>;
const deleteSourceMock = deleteSourceForOwner as unknown as ReturnType<typeof vi.fn>;
const getPrivateBlobMock = getPrivateBlob as unknown as ReturnType<typeof vi.fn>;
const ingestSourceMock = ingestSource as unknown as ReturnType<typeof vi.fn>;
const createIngestBudgetMock = createIngestBudget as unknown as ReturnType<typeof vi.fn>;
const replaceFailedMock = replaceFailedSourceIngest as unknown as ReturnType<typeof vi.fn>;

const context = { params: Promise.resolve({ id: "reviewer-1", sourceId: "source-1" }) };

describe("source file route", () => {
  beforeEach(() => {
    authMock.mockReset();
    reviewerMock.mockReset();
    sourceMock.mockReset();
    deleteBlobMock.mockReset();
    beginSourceDeletionMock.mockReset();
    deleteSourceMock.mockReset();
    getPrivateBlobMock.mockReset();
    ingestSourceMock.mockReset();
    createIngestBudgetMock.mockReset();
    replaceFailedMock.mockReset();
    createIngestBudgetMock.mockReturnValue({
      signal: new AbortController().signal,
      throwIfExpired: () => undefined,
      dispose: () => undefined,
    });
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    reviewerMock.mockResolvedValue({ id: "reviewer-1" });
    sourceMock.mockResolvedValue({
      id: "source-1",
      reviewerId: "reviewer-1",
      kind: "paste",
      mime: "text/plain",
      blobPathname: null,
    });
    beginSourceDeletionMock.mockResolvedValue({
      id: "source-1",
      reviewerId: "reviewer-1",
      kind: "paste",
      mime: "text/plain",
      blobPathname: null,
    });
    deleteSourceMock.mockResolvedValue({ id: "source-1" });
  });

  it("deletes paste rows without trying to delete a Blob", async () => {
    const response = await DELETE(new Request("https://omni-reviewer.example"), context);
    expect(response.status).toBe(200);
    expect(deleteBlobMock).not.toHaveBeenCalled();
    expect(deleteSourceMock).toHaveBeenCalledWith("source-1", "reviewer-1", "user-1");
  });

  it("does not expose a file response for a paste source", async () => {
    const response = await GET(new Request("https://omni-reviewer.example"), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Source file unavailable" });
    expect(getPrivateBlobMock).not.toHaveBeenCalled();
  });

  it("retries a failed PDF from the stored blob and keeps the provider URL private", async () => {
    sourceMock.mockResolvedValue({
      id: "source-1",
      reviewerId: "reviewer-1",
      filename: "lecture.pdf",
      mime: "application/pdf",
      kind: "pdf",
      blobUrl: "https://blob.example/private/lecture.pdf",
      blobPathname: "users/user-1/reviewers/reviewer-1/lecture.pdf",
      ingestStatus: "failed",
      errorMessage: "PDF parser exceeded the safe memory limit",
      deletingAt: null,
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
    });
    ingestSourceMock.mockResolvedValue({
      kind: "pdf",
      ingestStatus: "ready",
      extractedText: "Antimicrobial agents",
      errorMessage: null,
    });
    replaceFailedMock.mockResolvedValue({
      id: "source-1",
      reviewerId: "reviewer-1",
      filename: "lecture.pdf",
      mime: "application/pdf",
      kind: "pdf",
      blobUrl: "https://blob.example/private/lecture.pdf",
      blobPathname: "users/user-1/reviewers/reviewer-1/lecture.pdf",
      ingestStatus: "ready",
      errorMessage: null,
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
    });

    const response = await POST(new Request("https://omni-reviewer.example"), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ingestStatus).toBe("ready");
    expect(body.blobUrl).toBe("/api/reviewers/reviewer-1/sources/source-1");
    expect(JSON.stringify(body)).not.toContain("blob.example");
    expect(ingestSourceMock).toHaveBeenCalledWith(expect.objectContaining({
      blobPathname: "users/user-1/reviewers/reviewer-1/lecture.pdf",
      mime: "application/pdf",
    }));
    expect(replaceFailedMock).toHaveBeenCalledWith(
      "user-1",
      "reviewer-1",
      "source-1",
      expect.objectContaining({ ingestStatus: "ready", extractedText: "Antimicrobial agents" }),
    );
  });

  it("refuses to retry a source that is not a failed stored file", async () => {
    sourceMock.mockResolvedValue({
      id: "source-1",
      reviewerId: "reviewer-1",
      filename: "notes.png",
      mime: "image/png",
      kind: "image",
      blobUrl: "https://blob.example/private/notes.png",
      blobPathname: "users/user-1/reviewers/reviewer-1/notes.png",
      ingestStatus: "failed",
      deletingAt: null,
    });

    const response = await POST(new Request("https://omni-reviewer.example"), context);
    expect(response.status).toBe(409);
    expect(ingestSourceMock).not.toHaveBeenCalled();
  });
});
