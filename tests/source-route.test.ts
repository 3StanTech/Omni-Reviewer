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
}));
vi.mock("@/lib/public-errors", () => ({
  logRedactedError: vi.fn(),
}));

import { auth } from "@/auth";
import { deleteBlobIfUnreferenced, getPrivateBlob } from "@/lib/blob";
import { beginSourceDeletion, deleteSourceForOwner, getReviewer, getSourceForReviewer } from "@/lib/queries";
import { DELETE, GET } from "@/app/api/reviewers/[id]/sources/[sourceId]/route";

const authMock = auth as unknown as ReturnType<typeof vi.fn>;
const reviewerMock = getReviewer as unknown as ReturnType<typeof vi.fn>;
const sourceMock = getSourceForReviewer as unknown as ReturnType<typeof vi.fn>;
const deleteBlobMock = deleteBlobIfUnreferenced as unknown as ReturnType<typeof vi.fn>;
const beginSourceDeletionMock = beginSourceDeletion as unknown as ReturnType<typeof vi.fn>;
const deleteSourceMock = deleteSourceForOwner as unknown as ReturnType<typeof vi.fn>;
const getPrivateBlobMock = getPrivateBlob as unknown as ReturnType<typeof vi.fn>;

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
});
