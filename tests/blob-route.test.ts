import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";

const authMock = auth as unknown as ReturnType<typeof vi.fn>;
const handleClientUpload = vi.fn();
const getReviewer = vi.fn();
const listSourcesForUi = vi.fn();
const verifyBlobMetadata = vi.fn();
const ingestSource = vi.fn();
const createSourceForOwner = vi.fn();
const reconcileUnregisteredBlobs = vi.fn();
const deleteBlobIfUnreferenced = vi.fn();
const releaseBlobReservation = vi.fn();
const reserveBlobForRegistration = vi.fn();
const createIngestBudget = vi.fn();

vi.mock("@/lib/blob", () => ({
  deleteBlobIfUnreferenced: (...args: unknown[]) => deleteBlobIfUnreferenced(...args),
  handleClientUpload: (...args: unknown[]) => handleClientUpload(...args),
  isAllowedMime: () => true,
  kindFromMime: () => "text",
  MAX_INGEST_BYTES: 50 * 1024 * 1024,
  MAX_UPLOAD_BYTES: 500 * 1024 * 1024,
  MAX_BLOB_ATTEMPT_TOKEN_CHARS: 128,
  MAX_BLOB_DELETE_WAIT_MS: 10_000,
  MAX_SOURCE_BODY_BYTES: 64 * 1024,
  normalizeMime: (mime: string) => mime.toLowerCase(),
  reconcileUnregisteredBlobs: (...args: unknown[]) => reconcileUnregisteredBlobs(...args),
  verifyBlobMetadata: (...args: unknown[]) => verifyBlobMetadata(...args),
  assertNamespacedPathname: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  createSourceForOwner: (...args: unknown[]) => createSourceForOwner(...args),
  getReviewer: (...args: unknown[]) => getReviewer(...args),
  listSourcesForUi: (...args: unknown[]) => listSourcesForUi(...args),
  releaseBlobReservation: (...args: unknown[]) => releaseBlobReservation(...args),
  reserveBlobForRegistration: (...args: unknown[]) => reserveBlobForRegistration(...args),
}));

vi.mock("@/lib/ingest", () => ({
  ingestSource: (...args: unknown[]) => ingestSource(...args),
  createIngestBudget: (...args: unknown[]) => createIngestBudget(...args),
}));

import { POST as uploadPost } from "@/app/api/blob/upload/route";
import {
  GET as sourcesGet,
  POST as sourcesPost,
} from "@/app/api/reviewers/[id]/sources/route";

function jsonRequest(body: unknown): Request {
  return new Request("https://omni-reviewer.example/api/blob/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("blob upload route contract", () => {
  beforeEach(() => {
    authMock.mockReset();
    handleClientUpload.mockReset();
    getReviewer.mockReset();
    listSourcesForUi.mockReset();
    verifyBlobMetadata.mockReset();
    ingestSource.mockReset();
    createSourceForOwner.mockReset();
    deleteBlobIfUnreferenced.mockReset();
    releaseBlobReservation.mockReset();
    reserveBlobForRegistration.mockReset();
    reserveBlobForRegistration.mockResolvedValue({ outcome: "reserved", sourceId: null });
    createIngestBudget.mockReset();
    createIngestBudget.mockImplementation(() => ({
      signal: new AbortController().signal,
      run: async (operation: (signal: AbortSignal) => Promise<unknown>) => operation(new AbortController().signal),
      throwIfExpired: vi.fn(),
      dispose: vi.fn(),
    }));
    reconcileUnregisteredBlobs.mockReset();
    reconcileUnregisteredBlobs.mockResolvedValue({ examined: 0, deleted: 0, failed: 0 });
  });

  it("rejects malformed JSON without invoking Blob", async () => {
    const response = await uploadPost(
      new Request("https://omni-reviewer.example/api/blob/upload", {
        method: "POST",
        body: "not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(handleClientUpload).not.toHaveBeenCalled();
  });

  it("rejects a huge public completion callback before parsing or session lookup", async () => {
    const response = await uploadPost(
      new Request("https://omni-reviewer.example/api/blob/upload", {
        method: "POST",
        headers: { "Content-Length": String(64 * 1024 + 1) },
        body: "x",
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Blob upload request body exceeds the safe size limit",
    });
    expect(authMock).not.toHaveBeenCalled();
    expect(handleClientUpload).not.toHaveBeenCalled();
  });

  it("caps a streamed public callback when Content-Length is absent", async () => {
    const response = await uploadPost(
      new Request("https://omni-reviewer.example/api/blob/upload", {
        method: "POST",
        body: JSON.stringify({
          type: "blob.upload-completed",
          payload: { blob: {}, padding: "x".repeat(70 * 1024) },
        }),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Blob upload request body exceeds the safe size limit",
    });
    expect(authMock).not.toHaveBeenCalled();
    expect(handleClientUpload).not.toHaveBeenCalled();
  });

  it("rejects unknown public upload keys before invoking Blob", async () => {
    const response = await uploadPost(
      jsonRequest({
        type: "blob.upload-completed",
        payload: { blob: {}, unexpected: "do not accept" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Blob upload request" });
    expect(authMock).not.toHaveBeenCalled();
    expect(handleClientUpload).not.toHaveBeenCalled();
  });

  it("caps raw source-registration JSON before parsing", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1" });
    const response = await sourcesPost(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "65537" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Source registration body exceeds the safe size limit",
    });
    expect(reserveBlobForRegistration).not.toHaveBeenCalled();
  });

  it("rejects unknown source-registration keys with the strict schema", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1" });
    const response = await sourcesPost(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "notes.txt",
          mime: "text/plain",
          blob_url: "https://store.private.blob.vercel-storage.com/file",
          blob_pathname: "users/user-1/reviewers/reviewer-1/file.txt",
          unexpected: "discard me",
        }),
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );

    expect(response.status).toBe(400);
    expect(reserveBlobForRegistration).not.toHaveBeenCalled();
  });

  it("requires a session before minting a client token", async () => {
    authMock.mockResolvedValue(null);
    const response = await uploadPost(
      jsonRequest({
        type: "blob.generate-client-token",
        payload: {
          pathname: "users/user-1/reviewers/reviewer-1/file.txt",
          multipart: false,
          clientPayload: null,
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(handleClientUpload).not.toHaveBeenCalled();
  });

  it("passes the authenticated user to the private token handshake", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    handleClientUpload.mockResolvedValue({
      type: "blob.generate-client-token",
      clientToken: "vercel_blob_client_test",
    });
    const body = {
      type: "blob.generate-client-token",
      payload: {
        pathname: "users/user-1/reviewers/reviewer-1/file.txt",
        multipart: false,
        clientPayload: null,
      },
    };
    const response = await uploadPost(
      jsonRequest(body),
    );

    expect(response.status).toBe(200);
    expect(handleClientUpload).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", body }),
    );
  });

  it("maps unexpected upload handshake errors to a generic public message", async () => {
    handleClientUpload.mockRejectedValue(new Error("secret provider response"));

    const response = await uploadPost(
      jsonRequest({ type: "blob.upload-completed", payload: { blob: {} } }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Blob upload handshake failed" });
  });

  it("cleans up an unregistered blob and redacts unexpected verification errors", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1" });
    verifyBlobMetadata.mockRejectedValue(new Error("private token leaked"));
    deleteBlobIfUnreferenced.mockResolvedValue(true);

    const pathname = "users/user-1/reviewers/reviewer-1/uploaded.txt";
    const response = await sourcesPost(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "uploaded.txt",
          mime: "text/plain",
          blob_url: `https://store.private.blob.vercel-storage.com/${pathname}`,
          blob_pathname: pathname,
          attempt_token: "attempt-token-123456",
        }),
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Blob verification failed" });
    expect(deleteBlobIfUnreferenced).toHaveBeenCalledWith(
      pathname,
      { userId: "user-1", reviewerId: "reviewer-1" },
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("does not publish a source after the shared ingest budget expires", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1" });
    verifyBlobMetadata.mockResolvedValue({});
    ingestSource.mockResolvedValue({
      kind: "text",
      ingestStatus: "ready",
      extractedText: "notes",
      errorMessage: null,
    });
    const budget = {
      signal: new AbortController().signal,
      run: async (operation: (signal: AbortSignal) => Promise<unknown>) => operation(new AbortController().signal),
      throwIfExpired: vi.fn(() => {
        throw new Error("deadline internals must stay private");
      }),
      dispose: vi.fn(),
    };
    createIngestBudget.mockReturnValueOnce(budget);
    deleteBlobIfUnreferenced.mockResolvedValue(true);

    const pathname = "users/user-1/reviewers/reviewer-1/expired.txt";
    const response = await sourcesPost(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "expired.txt",
          mime: "text/plain",
          blob_url: `https://store.private.blob.vercel-storage.com/${pathname}`,
          blob_pathname: pathname,
          attempt_token: "attempt-token-123456",
        }),
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Source ingest failed" });
    expect(createSourceForOwner).not.toHaveBeenCalled();
    expect(deleteBlobIfUnreferenced).toHaveBeenCalledWith(
      pathname,
      { userId: "user-1", reviewerId: "reviewer-1" },
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(budget.dispose).toHaveBeenCalled();
  });

  it("passes the minted attempt token through registration and persistence", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1" });
    verifyBlobMetadata.mockResolvedValue({});
    ingestSource.mockResolvedValue({
      kind: "document",
      ingestStatus: "ready",
      extractedText: "docx notes",
      errorMessage: null,
    });
    reserveBlobForRegistration.mockResolvedValue({
      outcome: "reserved",
      sourceId: null,
      attemptToken: "attempt-token-123456",
    });
    createSourceForOwner.mockResolvedValue({
      id: "source-1",
      reviewerId: "reviewer-1",
      filename: "notes.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      kind: "document",
      blobUrl: "https://store.private.blob.vercel-storage.com/blob",
      blobPathname: "users/user-1/reviewers/reviewer-1/blob.docx",
      ingestStatus: "ready",
      errorMessage: null,
      createdAt: new Date("2026-08-30T00:00:00Z"),
    });

    const pathname = "users/user-1/reviewers/reviewer-1/uploaded.docx";
    const attemptToken = "attempt-token-123456";
    const response = await sourcesPost(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "notes.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          blob_url: `https://store.private.blob.vercel-storage.com/${pathname}`,
          blob_pathname: pathname,
          attempt_token: attemptToken,
        }),
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );

    expect(response.status).toBe(201);
    expect(reserveBlobForRegistration).toHaveBeenCalledWith(
      "user-1",
      "reviewer-1",
      pathname,
      attemptToken,
    );
    expect(createSourceForOwner).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ blobPathname: pathname }),
      attemptToken,
    );
  });

  it("rejects a different live attempt before reading or registering the Blob", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1" });
    reserveBlobForRegistration.mockResolvedValue({
      outcome: "conflict",
      sourceId: null,
      attemptToken: null,
    });
    const pathname = "users/user-1/reviewers/reviewer-1/conflict.docx";
    const response = await sourcesPost(
      new Request("https://omni-reviewer.example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "conflict.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          blob_url: `https://store.private.blob.vercel-storage.com/${pathname}`,
          blob_pathname: pathname,
          attempt_token: "different-token-123456",
        }),
      }),
      { params: Promise.resolve({ id: "reviewer-1" }) },
    );

    expect(response.status).toBe(409);
    expect(verifyBlobMetadata).not.toHaveBeenCalled();
    expect(createSourceForOwner).not.toHaveBeenCalled();
  });

  it("serializes source records with authenticated URLs only", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1" });
    listSourcesForUi.mockResolvedValue([
      {
        id: "source-1",
        reviewerId: "reviewer-1",
        filename: "notes.txt",
        mime: "text/plain",
        kind: "text",
        blobUrl: "https://store.private.blob.vercel-storage.com/secret",
        blobPathname: "users/user-1/reviewers/reviewer-1/file.txt",
        ingestStatus: "ready",
        errorMessage: null,
        createdAt: new Date("2026-08-30T00:00:00Z"),
      },
    ]);

    const response = await sourcesGet(new Request("https://omni-reviewer.example"), {
      params: Promise.resolve({ id: "reviewer-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0].blobUrl).toBe("/api/reviewers/reviewer-1/sources/source-1");
    expect(body[0].blob_url).toBe("/api/reviewers/reviewer-1/sources/source-1");
    expect(JSON.stringify(body)).not.toContain("store.private.blob.vercel-storage.com");
    expect(reconcileUnregisteredBlobs).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        reviewerId: "reviewer-1",
        referencedPathnames: ["users/user-1/reviewers/reviewer-1/file.txt"],
      }),
    );
  });

  it("sanitizes legacy persisted source errors before returning them", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    getReviewer.mockResolvedValue({ id: "reviewer-1" });
    listSourcesForUi.mockResolvedValue([
      {
        id: "source-1",
        reviewerId: "reviewer-1",
        filename: "notes.txt",
        mime: "text/plain",
        kind: "text",
        blobUrl: "https://store.private.blob.vercel-storage.com/secret",
        blobPathname: "users/user-1/reviewers/reviewer-1/file.txt",
        ingestStatus: "failed",
        errorMessage: "database password=secret",
        createdAt: new Date("2026-08-30T00:00:00Z"),
      },
    ]);

    const response = await sourcesGet(new Request("https://omni-reviewer.example"), {
      params: Promise.resolve({ id: "reviewer-1" }),
    });
    const body = await response.json();
    expect(body[0].errorMessage).toBe("Source processing failed.");
    expect(JSON.stringify(body)).not.toContain("database password");
  });
});
