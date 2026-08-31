import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getBlob = vi.fn();
const headBlob = vi.fn();
const deleteBlobApi = vi.fn();
const listBlob = vi.fn();
const handleUpload = vi.fn();
const reviewerLookup = vi.fn();
const reservationLookup = vi.fn();
const claimDeletion = vi.fn();
const completeDeletion = vi.fn();
const requeueDeletion = vi.fn();
const reserveRegistration = vi.fn();

vi.mock("@vercel/blob", () => ({
  del: (...args: unknown[]) => deleteBlobApi(...args),
  get: (...args: unknown[]) => getBlob(...args),
  head: (...args: unknown[]) => headBlob(...args),
  list: (...args: unknown[]) => listBlob(...args),
  put: vi.fn(),
}));

vi.mock("@vercel/blob/client", () => ({
  handleUpload: (...args: unknown[]) => handleUpload(...args),
}));

vi.mock("@/lib/queries", () => ({
  getReviewer: (...args: unknown[]) => reviewerLookup(...args),
  listBlobReservationsForReviewer: (...args: unknown[]) => reservationLookup(...args),
  claimBlobDeletion: (...args: unknown[]) => claimDeletion(...args),
  completeBlobDeletion: (...args: unknown[]) => completeDeletion(...args),
  requeueBlobDeletion: (...args: unknown[]) => requeueDeletion(...args),
  reserveBlobForRegistration: (...args: unknown[]) => reserveRegistration(...args),
}));

import {
  assertBlobUrlMatchesPathname,
  assertNamespacedPathname,
  deleteBlob,
  deleteBlobWithOutcome,
  deleteBlobIfUnreferenced,
  handleClientUpload,
  isAllowedMime,
  kindFromMime,
  MAX_INGEST_BYTES,
  readPrivateBlobBytes,
  reconcileUnregisteredBlobs,
  verifyBlobMetadata,
} from "@/lib/blob";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const REVIEWER_ID = "22222222-2222-2222-2222-222222222222";
const PATHNAME =
  `users/${USER_ID}/reviewers/${REVIEWER_ID}/33333333-3333-3333-3333-333333333333-notes.txt`;
const URL = `https://store.private.blob.vercel-storage.com/${PATHNAME}`;

function privateResult(
  bytes = new Uint8Array([1, 2, 3]),
  statusCode: 200 | 206 = 200,
) {
  return {
    statusCode,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    blob: {
      pathname: PATHNAME,
      size: bytes.byteLength,
      contentType: "text/plain",
    },
  };
}

describe("Vercel Blob security helpers", () => {
  beforeEach(() => {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    getBlob.mockReset();
    headBlob.mockReset();
    headBlob.mockResolvedValue({ etag: "test-etag" });
    deleteBlobApi.mockReset();
    listBlob.mockReset();
    handleUpload.mockReset();
    reviewerLookup.mockReset();
    reservationLookup.mockReset();
    claimDeletion.mockReset();
    completeDeletion.mockReset();
    requeueDeletion.mockReset();
    reserveRegistration.mockReset();
    reservationLookup.mockResolvedValue([]);
    claimDeletion.mockResolvedValue(true);
    completeDeletion.mockResolvedValue(undefined);
    requeueDeletion.mockResolvedValue(undefined);
    reserveRegistration.mockResolvedValue({ outcome: "reserved", sourceId: null });
  });

  it("requires a complete owner/reviewer namespace", () => {
    expect(() => assertNamespacedPathname(PATHNAME, { userId: USER_ID, reviewerId: REVIEWER_ID })).not.toThrow();
    expect(() => assertNamespacedPathname("users/other/file.txt")).toThrow(/namespaced/i);
    expect(() => assertNamespacedPathname(`${PATHNAME}/nested`)).toThrow(/namespaced/i);
    expect(() => assertNamespacedPathname(PATHNAME.replace(/33333333[^/]+-/, "not-a-uuid-"))).toThrow(/namespaced/i);
    expect(() =>
      assertNamespacedPathname(PATHNAME, { userId: "44444444-4444-4444-4444-444444444444" }),
    ).toThrow(/userId/i);
  });

  it("classifies DOCX and PPTX while rejecting unapproved office MIME types", () => {
    expect(isAllowedMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe(true);
    expect(kindFromMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe("document");
    expect(kindFromMime("application/vnd.openxmlformats-officedocument.presentationml.presentation"))
      .toBe("presentation");
    expect(isAllowedMime("application/msword")).toBe(false);
    expect(kindFromMime("application/msword")).toBeNull();
  });

  it("rejects external URLs, query strings, and pathname mismatches", () => {
    expect(() => assertBlobUrlMatchesPathname("https://example.com/file.txt", PATHNAME)).toThrow(/Vercel Blob/i);
    expect(() => assertBlobUrlMatchesPathname(`https://store.public.blob.vercel-storage.com/${PATHNAME}`, PATHNAME)).toThrow(/Vercel Blob/i);
    expect(() => assertBlobUrlMatchesPathname(`${URL}?download=1`, PATHNAME)).toThrow(/canonical/i);
    expect(() => assertBlobUrlMatchesPathname(URL.replace("notes.txt", "other.txt"), PATHNAME)).toThrow(/pathname/i);
    expect(() => assertBlobUrlMatchesPathname(URL, PATHNAME)).not.toThrow();
  });

  it("verifies metadata, private access, MIME, owner namespace, and size", async () => {
    headBlob.mockResolvedValue({
      pathname: PATHNAME,
      size: 3,
      contentType: "text/plain",
      url: URL,
    });
    getBlob.mockResolvedValue(privateResult());

    await expect(
      verifyBlobMetadata({
        blobUrl: URL,
        pathname: PATHNAME,
        mime: "text/plain",
        userId: USER_ID,
        reviewerId: REVIEWER_ID,
      }),
    ).resolves.toMatchObject({ pathname: PATHNAME });
    expect(headBlob).toHaveBeenCalledWith(
      PATHNAME,
      expect.objectContaining({ token: expect.anything() }),
    );
    expect(getBlob).toHaveBeenCalledWith(
      PATHNAME,
      expect.objectContaining({
        access: "private",
        headers: { Range: "bytes=0-0" },
      }),
    );

    headBlob.mockResolvedValue({
      pathname: PATHNAME,
      size: 3,
      contentType: "text/plain",
      url: URL,
    });
    getBlob.mockResolvedValue(privateResult(new Uint8Array([1, 2, 3]), 206));
    await expect(
      verifyBlobMetadata({
        blobUrl: URL,
        pathname: PATHNAME,
        mime: "text/plain",
        userId: USER_ID,
        reviewerId: REVIEWER_ID,
      }),
    ).resolves.toMatchObject({ pathname: PATHNAME });

    headBlob.mockResolvedValue({ pathname: PATHNAME, size: 3, contentType: "image/png", url: URL });
    await expect(
      verifyBlobMetadata({
        blobUrl: URL,
        pathname: PATHNAME,
        mime: "text/plain",
        userId: USER_ID,
        reviewerId: REVIEWER_ID,
      }),
    ).rejects.toThrow(/content type/i);

    headBlob.mockResolvedValue({ pathname: PATHNAME, size: MAX_INGEST_BYTES + 1, contentType: "text/plain", url: URL });
    await expect(
      verifyBlobMetadata({
        blobUrl: URL,
        pathname: PATHNAME,
        mime: "text/plain",
        userId: USER_ID,
        reviewerId: REVIEWER_ID,
      }),
    ).rejects.toThrow(/limit/i);
  });

  it("reads by pathname with private access and enforces the streamed byte cap", async () => {
    getBlob.mockResolvedValue(privateResult(new Uint8Array([10, 20, 30])));
    await expect(readPrivateBlobBytes(PATHNAME, 3)).resolves.toEqual(
      new Uint8Array([10, 20, 30]),
    );
    expect(getBlob).toHaveBeenCalledWith(
      PATHNAME,
      expect.objectContaining({ access: "private", useCache: false }),
    );

    getBlob.mockResolvedValue({
      ...privateResult(),
      blob: { ...privateResult().blob, size: 4 },
    });
    await expect(readPrivateBlobBytes(PATHNAME, 3)).rejects.toThrow(/limit/i);
  });

  it("passes the route abort signal to metadata and private-access checks", async () => {
    const controller = new AbortController();
    headBlob.mockResolvedValue({ pathname: PATHNAME, size: 3, contentType: "text/plain", url: URL });
    getBlob.mockResolvedValue(privateResult());

    await verifyBlobMetadata({
      blobUrl: URL,
      pathname: PATHNAME,
      mime: "text/plain",
      userId: USER_ID,
      reviewerId: REVIEWER_ID,
      abortSignal: controller.signal,
    });

    expect(headBlob).toHaveBeenCalledWith(PATHNAME, expect.objectContaining({ abortSignal: controller.signal }));
    expect(getBlob).toHaveBeenCalledWith(PATHNAME, expect.objectContaining({ abortSignal: controller.signal }));
  });

  it("only deletes validated Vercel Blob paths", async () => {
    await deleteBlob("https://example.com/secret", { userId: USER_ID, reviewerId: REVIEWER_ID });
    expect(deleteBlobApi).not.toHaveBeenCalled();

    await deleteBlob(PATHNAME, { userId: USER_ID, reviewerId: REVIEWER_ID });
    expect(deleteBlobApi).toHaveBeenCalledWith(
      PATHNAME,
      expect.objectContaining({ token: expect.anything() }),
    );
  });

  it("requires the authenticated owner and reviewer for deletion", async () => {
    await deleteBlob(PATHNAME, { userId: "44444444-4444-4444-4444-444444444444", reviewerId: REVIEWER_ID });
    await deleteBlob(PATHNAME, { userId: USER_ID, reviewerId: "44444444-4444-4444-4444-444444444444" });
    expect(deleteBlobApi).not.toHaveBeenCalled();
  });

  it("reports provider deletion failure so callers can retain a retryable row", async () => {
    deleteBlobApi.mockRejectedValue(new Error("provider secret details"));

    await expect(deleteBlob(PATHNAME, { userId: USER_ID, reviewerId: REVIEWER_ID })).resolves.toBe(false);
  });

  it("treats a provider-confirmed missing object as already deleted", async () => {
    const missing = new Error("not found");
    missing.name = "BlobNotFoundError";
    headBlob.mockRejectedValue(missing);

    await expect(
      deleteBlob(PATHNAME, { userId: USER_ID, reviewerId: REVIEWER_ID }),
    ).resolves.toBe(true);
    expect(deleteBlobApi).not.toHaveBeenCalled();
  });

  it("reports settled provider outcomes and fails closed without an ETag", async () => {
    headBlob.mockResolvedValue({ pathname: PATHNAME });

    await expect(
      deleteBlobWithOutcome(PATHNAME, { userId: USER_ID, reviewerId: REVIEWER_ID }),
    ).resolves.toEqual({ status: "failed", retryable: true, inFlight: false });
    expect(deleteBlobApi).not.toHaveBeenCalled();

    headBlob.mockResolvedValue({ etag: "etag-before-delete" });
    deleteBlobApi.mockRejectedValue(new Error("provider unavailable"));
    await expect(
      deleteBlobWithOutcome(PATHNAME, { userId: USER_ID, reviewerId: REVIEWER_ID }),
    ).resolves.toEqual({ status: "failed", retryable: true, inFlight: false });

    const missing = new Error("not found");
    missing.name = "BlobNotFoundError";
    headBlob.mockRejectedValue(missing);
    await expect(
      deleteBlobWithOutcome(PATHNAME, { userId: USER_ID, reviewerId: REVIEWER_ID }),
    ).resolves.toEqual({ status: "not-found", retryable: false, inFlight: false });
  });

  it("bounds a hanging provider delete with the shared abort signal", async () => {
    headBlob.mockResolvedValue({ etag: "etag-before-delete" });
    deleteBlobApi.mockImplementation(() => new Promise<void>(() => {}));
    const controller = new AbortController();

    await expect(
      deleteBlob(
        PATHNAME,
        { userId: USER_ID, reviewerId: REVIEWER_ID },
        { abortSignal: controller.signal, maxWaitMs: 5 },
      ),
    ).resolves.toBe(false);
    await expect(
      deleteBlobWithOutcome(
        PATHNAME,
        { userId: USER_ID, reviewerId: REVIEWER_ID },
        { maxWaitMs: 5 },
      ),
    ).resolves.toMatchObject({ status: "timeout", inFlight: true });
    expect(deleteBlobApi).toHaveBeenCalledWith(
      PATHNAME,
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        ifMatch: "etag-before-delete",
      }),
    );
  });

  it("CASes completion and requeue to the deletion attempt token", async () => {
    claimDeletion.mockResolvedValue({ attemptToken: "claim-token-123456" });
    headBlob.mockResolvedValue({ etag: "etag-before-delete" });
    deleteBlobApi.mockResolvedValue(undefined);

    await expect(
      deleteBlobIfUnreferenced(
        PATHNAME,
        { userId: USER_ID, reviewerId: REVIEWER_ID },
      ),
    ).resolves.toBe(true);
    expect(completeDeletion).toHaveBeenCalledWith(
      USER_ID,
      REVIEWER_ID,
      PATHNAME,
      "claim-token-123456",
    );

    completeDeletion.mockReset();
    requeueDeletion.mockReset();
    deleteBlobApi.mockImplementation(() => new Promise<void>(() => {}));
    await expect(
      deleteBlobIfUnreferenced(
        PATHNAME,
        { userId: USER_ID, reviewerId: REVIEWER_ID },
        { maxWaitMs: 5 },
      ),
    ).resolves.toBe(false);
    // A timed-out/non-cooperative provider call keeps the deleting lease
    // until expiry; requeueing immediately could admit a replacement while
    // the old provider request is still in flight.
    expect(requeueDeletion).not.toHaveBeenCalled();
    expect(completeDeletion).not.toHaveBeenCalled();
  });

  it("completes an exact deletion claim when the provider confirms Blob absence", async () => {
    claimDeletion.mockResolvedValue({ attemptToken: "missing-claim-token" });
    const missing = new Error("not found");
    missing.name = "BlobNotFoundError";
    headBlob.mockRejectedValue(missing);

    await expect(
      deleteBlobIfUnreferenced(
        PATHNAME,
        { userId: USER_ID, reviewerId: REVIEWER_ID },
      ),
    ).resolves.toBe(true);
    expect(completeDeletion).toHaveBeenCalledWith(
      USER_ID,
      REVIEWER_ID,
      PATHNAME,
      "missing-claim-token",
    );
    expect(requeueDeletion).not.toHaveBeenCalled();
  });

  it("ignores a late provider completion after the deletion lease timed out", async () => {
    claimDeletion.mockResolvedValue({ attemptToken: "late-claim-token" });
    headBlob.mockResolvedValue({ etag: "old-etag" });
    let resolveLate: (() => void) | undefined;
    deleteBlobApi.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveLate = resolve;
      }),
    );

    await expect(
      deleteBlobIfUnreferenced(
        PATHNAME,
        { userId: USER_ID, reviewerId: REVIEWER_ID },
        { maxWaitMs: 20 },
      ),
    ).resolves.toBe(false);
    expect(deleteBlobApi).toHaveBeenCalledWith(
      PATHNAME,
      expect.objectContaining({ ifMatch: "old-etag" }),
    );

    resolveLate?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completeDeletion).not.toHaveBeenCalled();
    expect(requeueDeletion).not.toHaveBeenCalled();
  });

  it("requeues a fail-closed missing-ETag claim without calling unconditional del", async () => {
    claimDeletion.mockResolvedValue({ attemptToken: "etagless-claim-token" });
    headBlob.mockResolvedValue({ pathname: PATHNAME });

    await expect(
      deleteBlobIfUnreferenced(
        PATHNAME,
        { userId: USER_ID, reviewerId: REVIEWER_ID },
        { maxWaitMs: 100 },
      ),
    ).resolves.toBe(false);
    expect(deleteBlobApi).not.toHaveBeenCalled();
    expect(requeueDeletion).toHaveBeenCalledWith(
      USER_ID,
      REVIEWER_ID,
      PATHNAME,
      "etagless-claim-token",
    );
  });

  it("requeues a provider failure only while the deletion attempt is still bounded", async () => {
    claimDeletion.mockResolvedValue({ attemptToken: "claim-token-123456" });
    deleteBlobApi.mockRejectedValue(new Error("provider unavailable"));

    await expect(
      deleteBlobIfUnreferenced(
        PATHNAME,
        { userId: USER_ID, reviewerId: REVIEWER_ID },
        { maxWaitMs: 100 },
      ),
    ).resolves.toBe(false);
    expect(requeueDeletion).toHaveBeenCalledWith(
      USER_ID,
      REVIEWER_ID,
      PATHNAME,
      "claim-token-123456",
    );
    expect(completeDeletion).not.toHaveBeenCalled();
  });

  it("reconciles only stale, unreferenced blobs in the authenticated reviewer prefix", async () => {
    const now = new Date("2026-08-30T12:00:00Z");
    const stalePath = PATHNAME.replace("notes.txt", "stale.txt");
    const freshPath = PATHNAME.replace("notes.txt", "fresh.txt");
    const referencedPath = PATHNAME.replace("notes.txt", "referenced.txt");
    listBlob.mockResolvedValue({
      blobs: [
        { pathname: stalePath, uploadedAt: new Date("2026-08-28T00:00:00Z") },
        { pathname: freshPath, uploadedAt: new Date("2026-08-30T11:59:00Z") },
        { pathname: referencedPath, uploadedAt: new Date("2026-08-28T00:00:00Z") },
        { pathname: `users/other/reviewers/${REVIEWER_ID}/bad.txt`, uploadedAt: new Date("2026-08-28T00:00:00Z") },
      ],
      hasMore: false,
    });

    await expect(
      reconcileUnregisteredBlobs({
        userId: USER_ID,
        reviewerId: REVIEWER_ID,
        referencedPathnames: [referencedPath],
        now,
        graceMs: 60 * 60 * 1000,
      }),
    ).resolves.toEqual({ examined: 4, deleted: 1, failed: 0 });
    expect(deleteBlobApi).toHaveBeenCalledTimes(1);
    expect(deleteBlobApi).toHaveBeenCalledWith(
      stalePath,
      expect.objectContaining({ token: expect.anything() }),
    );
    expect(listBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: `users/${USER_ID}/reviewers/${REVIEWER_ID}/`,
      }),
    );
  });

  it("does not reconcile a live upload reservation even when its Blob is stale", async () => {
    const now = new Date("2026-08-30T12:00:00Z");
    const reservedPath = PATHNAME.replace("notes.txt", "still-uploading.txt");
    reservationLookup.mockResolvedValue([{
      pathname: reservedPath,
      state: "reserved",
      leaseExpiresAt: new Date("2026-08-30T13:00:00Z"),
    }]);
    listBlob.mockResolvedValue({
      blobs: [{ pathname: reservedPath, uploadedAt: new Date("2026-08-28T00:00:00Z") }],
      hasMore: false,
    });

    await expect(reconcileUnregisteredBlobs({
      userId: USER_ID,
      reviewerId: REVIEWER_ID,
      referencedPathnames: [],
      now,
      graceMs: 60 * 60 * 1000,
    })).resolves.toEqual({ examined: 1, deleted: 0, failed: 0 });
    expect(deleteBlobApi).not.toHaveBeenCalled();
  });

  it("retries an expired deletion lease instead of stranding an orphan", async () => {
    const now = new Date("2026-08-30T12:00:00Z");
    const deletingPath = PATHNAME.replace("notes.txt", "retry-delete.txt");
    reservationLookup.mockResolvedValue([{
      pathname: deletingPath,
      state: "deleting",
      leaseExpiresAt: new Date("2026-08-30T11:00:00Z"),
    }]);
    listBlob.mockResolvedValue({
      blobs: [{ pathname: deletingPath, uploadedAt: new Date("2026-08-28T00:00:00Z") }],
      hasMore: false,
    });

    await expect(reconcileUnregisteredBlobs({
      userId: USER_ID,
      reviewerId: REVIEWER_ID,
      referencedPathnames: [],
      now,
      graceMs: 60 * 60 * 1000,
    })).resolves.toEqual({ examined: 1, deleted: 1, failed: 0 });
    expect(claimDeletion).toHaveBeenCalledWith(
      USER_ID,
      REVIEWER_ID,
      deletingPath,
      false,
    );
    expect(deleteBlobApi).toHaveBeenCalledWith(
      deletingPath,
      expect.objectContaining({ token: expect.anything() }),
    );
  });

  it("checks reviewer ownership before minting an upload token", async () => {
    const body = {
      type: "blob.generate-client-token",
      payload: {
        pathname: PATHNAME,
        multipart: false,
        clientPayload: JSON.stringify({ reviewerId: REVIEWER_ID, filename: "notes.txt" }),
      },
    } as const;
    handleUpload.mockImplementation(async (options: {
      onBeforeGenerateToken: (
        pathname: string,
        clientPayload: string | null,
        multipart: boolean,
      ) => Promise<unknown>;
    }) => {
      await options.onBeforeGenerateToken(
        body.payload.pathname,
        body.payload.clientPayload,
        body.payload.multipart,
      );
      return { type: body.type, clientToken: "token" };
    });

    reviewerLookup.mockResolvedValue({ id: REVIEWER_ID });
    await expect(
      handleClientUpload({
        request: new Request("https://omni-reviewer.example/api/blob/upload"),
        body,
        userId: USER_ID,
      }),
    ).resolves.toMatchObject({ clientToken: "token" });
    expect(reviewerLookup).toHaveBeenCalledWith(REVIEWER_ID, USER_ID);

    reviewerLookup.mockResolvedValue(null);
    await expect(
      handleClientUpload({
        request: new Request("https://omni-reviewer.example/api/blob/upload"),
        body,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/reviewer not found/i);
  });

  it("mints one opaque attempt token and threads it into the reservation", async () => {
    const body = {
      type: "blob.generate-client-token",
      payload: {
        pathname: PATHNAME,
        multipart: false,
        clientPayload: JSON.stringify({ reviewerId: REVIEWER_ID, filename: "notes.txt" }),
      },
    } as const;
    let mintedPayload: string | null = null;
    handleUpload.mockImplementation(async (options: {
      body: typeof body;
      onBeforeGenerateToken: (
        pathname: string,
        clientPayload: string | null,
        multipart: boolean,
      ) => Promise<unknown>;
    }) => {
      mintedPayload = options.body.payload.clientPayload;
      await options.onBeforeGenerateToken(
        options.body.payload.pathname,
        options.body.payload.clientPayload,
        options.body.payload.multipart,
      );
      return { type: body.type, clientToken: "token" };
    });
    reviewerLookup.mockResolvedValue({ id: REVIEWER_ID });

    const result = await handleClientUpload({
      request: new Request("https://omni-reviewer.example/api/blob/upload"),
      body,
      userId: USER_ID,
    });

    expect(result).toMatchObject({ clientToken: "token" });
    if (result.type !== "blob.generate-client-token") throw new Error("expected token response");
    expect(result.attemptToken).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(mintedPayload).toBeTruthy();
    expect(JSON.parse(mintedPayload!)).toMatchObject({
      reviewerId: REVIEWER_ID,
      attemptToken: result.attemptToken,
    });
    expect(reserveRegistration).toHaveBeenCalledWith(
      USER_ID,
      REVIEWER_ID,
      PATHNAME,
      result.attemptToken,
      undefined,
      { allowTokenCreation: true },
    );
  });
});
