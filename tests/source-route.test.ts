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
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn() } }));
vi.mock("@/lib/ingest", () => ({
  createIngestBudget: vi.fn(),
  ingestSource: vi.fn(),
}));
vi.mock("@/lib/public-errors", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-errors")>("@/lib/public-errors");
  return { ...actual, logRedactedError: vi.fn() };
});

import { auth } from "@/auth";
import { db } from "@/lib/db";
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

const executeMock = db.execute as unknown as ReturnType<typeof vi.fn>;

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
    executeMock.mockReset();
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

  describe("page number refresh", () => {
    const pathname = "users/user-1/reviewers/reviewer-1/lecture.pdf";
    const readySource = {
      id: "source-1",
      reviewerId: "reviewer-1",
      filename: "lecture.pdf",
      mime: "application/pdf",
      kind: "pdf",
      blobUrl: "https://blob.example/private/lecture.pdf",
      blobPathname: pathname,
      ingestStatus: "ready",
      extractedText: "Antimicrobial agents",
      errorMessage: null,
      deletingAt: null,
      createdAt: new Date("2026-09-22T00:00:00.000Z"),
    };
    const markedText = "<<<page 1>>>\n\nAntimicrobial agents";
    const refresh = () =>
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "page_markers" }),
      });

    it("re-reads a ready PDF from the stored blob and reports markers without exposing text", async () => {
      sourceMock
        .mockResolvedValueOnce(readySource)
        .mockResolvedValueOnce({ ...readySource, extractedText: markedText });
      ingestSourceMock.mockResolvedValue({
        kind: "pdf",
        ingestStatus: "ready",
        extractedText: markedText,
        errorMessage: null,
      });
      executeMock.mockResolvedValue({ rows: [{ id: "source-1" }] });

      const response = await POST(refresh(), context);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.hasPageMarkers).toBe(true);
      expect(body.ingestStatus).toBe("ready");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("blob.example");
      expect(serialized).not.toContain("Antimicrobial");
      expect(ingestSourceMock).toHaveBeenCalledWith(expect.objectContaining({ blobPathname: pathname }));
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(replaceFailedMock).not.toHaveBeenCalled();
    });

    it.each([
      ["already has page numbers", { extractedText: markedText }],
      ["is not a PDF or PPTX", { kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }],
      ["failed", { ingestStatus: "failed" }],
    ])("refuses a source that %s with 409", async (_label, overrides) => {
      sourceMock.mockResolvedValue({ ...readySource, ...overrides });

      const response = await POST(refresh(), context);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/ready PDF or PPTX/);
      expect(ingestSourceMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
    });

    it("returns 404 for another owner's source", async () => {
      reviewerMock.mockResolvedValue(null);
      sourceMock.mockResolvedValue(null);

      const response = await POST(refresh(), context);
      expect(response.status).toBe(404);
      expect(ingestSourceMock).not.toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
    });

    it("keeps the stored text when the re-read finds no page numbers", async () => {
      sourceMock.mockResolvedValue(readySource);
      ingestSourceMock.mockResolvedValue({
        kind: "pdf",
        ingestStatus: "ready",
        extractedText: "Antimicrobial agents",
        errorMessage: null,
      });

      const response = await POST(refresh(), context);
      expect(response.status).toBe(422);
      expect(executeMock).not.toHaveBeenCalled();
    });

    it("lets a concurrent delete win", async () => {
      sourceMock
        .mockResolvedValueOnce(readySource)
        .mockResolvedValueOnce({ ...readySource, deletingAt: new Date() });
      ingestSourceMock.mockResolvedValue({
        kind: "pdf",
        ingestStatus: "ready",
        extractedText: markedText,
        errorMessage: null,
      });
      executeMock.mockResolvedValue({ rows: [] });

      const response = await POST(refresh(), context);
      expect(response.status).toBe(404);
    });

    it("rejects an oversize retry body with 413 before touching the source", async () => {
      const response = await POST(new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "page_markers", padding: "x".repeat(2048) }),
      }), context);
      expect(response.status).toBe(413);
      expect((await response.json()).error).toMatch(/size limit/);
      expect(sourceMock).not.toHaveBeenCalled();
      expect(ingestSourceMock).not.toHaveBeenCalled();
    });

    it("rejects invalid JSON with 400", async () => {
      const response = await POST(new Request("https://omni-reviewer.example", {
        method: "POST",
        body: "{not json",
      }), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid JSON body" });
      expect(ingestSourceMock).not.toHaveBeenCalled();
    });

    it("treats another reason as a plain failed-source retry", async () => {
      sourceMock.mockResolvedValue({ ...readySource, ingestStatus: "failed" });
      ingestSourceMock.mockResolvedValue({
        kind: "pdf",
        ingestStatus: "ready",
        extractedText: markedText,
        errorMessage: null,
      });
      replaceFailedMock.mockResolvedValue({ ...readySource, extractedText: markedText });

      const response = await POST(new Request("https://omni-reviewer.example", {
        method: "POST",
        body: JSON.stringify({ reason: "other" }),
      }), context);
      expect(response.status).toBe(200);
      expect(replaceFailedMock).toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
    });

    it("still retries a failed source when the body is empty", async () => {
      sourceMock.mockResolvedValue({ ...readySource, ingestStatus: "failed" });
      ingestSourceMock.mockResolvedValue({
        kind: "pdf",
        ingestStatus: "ready",
        extractedText: markedText,
        errorMessage: null,
      });
      replaceFailedMock.mockResolvedValue({ ...readySource, extractedText: markedText });

      const response = await POST(new Request("https://omni-reviewer.example", { method: "POST" }), context);
      expect(response.status).toBe(200);
      expect(replaceFailedMock).toHaveBeenCalled();
      expect(executeMock).not.toHaveBeenCalled();
      expect((await response.json()).hasPageMarkers).toBe(true);
    });
  });

  describe("source serializer page markers", () => {
    it("reports markers from full rows and unknown for list rows, never the text", async () => {
      const { serializeSource } = await import("@/lib/source-response");
      const base = {
        id: "source-1",
        reviewerId: "reviewer-1",
        filename: "lecture.pdf",
        mime: "application/pdf",
        kind: "pdf",
        blobUrl: "https://blob.example/private/lecture.pdf",
        blobPathname: "p",
        ingestStatus: "ready",
        errorMessage: null,
        createdAt: new Date("2026-09-22T00:00:00.000Z"),
      };
      const marked = serializeSource({ ...base, extractedText: "<<<page 1>>>\n\nSecret body" }, null);
      expect(marked.hasPageMarkers).toBe(true);
      expect(JSON.stringify(marked)).not.toContain("Secret body");
      expect(serializeSource({ ...base, extractedText: "Plain" }, null).hasPageMarkers).toBe(false);
      expect(serializeSource(base, null).hasPageMarkers).toBeNull();
      expect(serializeSource({ ...base, hasPageMarkers: false }, null).hasPageMarkers).toBe(false);
    });
  });
});

