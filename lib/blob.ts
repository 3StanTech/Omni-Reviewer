/**
 * Vercel Blob helpers for client-direct uploads.
 *
 * Large files (PDF / video / audio) must not pass through the App Router
 * request body — browsers upload bytes straight to Vercel Blob with a
 * short-lived client token from /api/blob/upload.
 *
 * After the upload finishes, the signed-in client POSTs
 * { filename, mime, blob_url, blob_pathname, attempt_token } to
 * /api/reviewers/[id]/sources. That route is the only writer of the
 * `sources` row and the only trigger for ingest.
 *
 * handleUpload's onUploadCompleted is not the persistence path: the Blob
 * service invokes it with no session cookie. Keep it a no-op (no DB writes).
 */

import "server-only";

import { del, get, head, list, put } from "@vercel/blob";
import {
  handleUpload,
  type HandleUploadBody,
} from "@vercel/blob/client";

import {
  claimBlobDeletion,
  completeBlobDeletion,
  getReviewer,
  listBlobReservationsForReviewer,
  requeueBlobDeletion,
  reserveBlobForRegistration,
} from "@/lib/queries";
import { logRedactedError, PublicError } from "@/lib/public-errors";
import type { SourceKind } from "@/lib/types";

/** MIME types accepted for upload and source registration. */
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/tab-separated-values",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/mpeg",
  "video/x-matroska",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/x-m4a",
] as const;

export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_MIME_TYPES);

/** 500 MiB — lecture video headroom; Blob still enforces per-token. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** Maximum size permitted for a server-side ingest/download. */
export const MAX_INGEST_BYTES = 50 * 1024 * 1024;

/** File-registration metadata is tiny; bytes never belong in this request. */
export const MAX_SOURCE_BODY_BYTES = 64 * 1024;

/** Maximum length accepted for the opaque upload/cleanup attempt token. */
export const MAX_BLOB_ATTEMPT_TOKEN_CHARS = 128;

/** Provider cleanup must not hold a request open indefinitely. */
export const MAX_BLOB_DELETE_WAIT_MS = 10_000;

const BLOB_OPERATION_ABORTED = Symbol("blob-operation-aborted");

/**
 * Direct-to-Blob uploads can finish before the authenticated registration
 * request, or the browser can disappear before registration entirely. Keep a
 * generous grace period for large uploads, then reconcile unreferenced files
 * on an authenticated source-list request.
 */
export const ORPHAN_BLOB_GRACE_MS = 24 * 60 * 60 * 1000;

const UUID_RE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const USER_REVIEWER_PATH_RE = new RegExp(
  `^users\\/(${UUID_RE})\\/reviewers\\/(${UUID_RE})\\/(${UUID_RE})-[a-zA-Z0-9._-]+$`,
  "i",
);

const BLOB_HOST_RE = /^[a-z0-9-]+\.private\.blob\.vercel-storage\.com$/i;

function blobStoreId(blobUrl: string): string | null {
  try {
    const parsed = new URL(blobUrl);
    if (!BLOB_HOST_RE.test(parsed.hostname)) return null;
    return parsed.hostname.split(".")[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * Neon HTTP queries do not accept an AbortSignal. Race their promise against
 * the same cleanup deadline used for provider work; a late query can still
 * finish, but every mutating query is token-CASed and no late provider call is
 * started by this request.
 */
async function runBlobOperation<T>(args: {
  operation: () => Promise<T> | T;
  abortSignal?: AbortSignal;
  deadline: number;
}): Promise<T | typeof BLOB_OPERATION_ABORTED> {
  if (args.abortSignal?.aborted || Date.now() >= args.deadline) {
    return BLOB_OPERATION_ABORTED;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof BLOB_OPERATION_ABORTED>((resolve) => {
    onAbort = () => resolve(BLOB_OPERATION_ABORTED);
    args.abortSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => resolve(BLOB_OPERATION_ABORTED), Math.max(1, args.deadline - Date.now()));
  });
  const operation = Promise.resolve()
    .then(args.operation)
    .catch((error: unknown) => {
      logRedactedError("Blob lifecycle operation failed", error);
      throw error;
    });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) args.abortSignal?.removeEventListener("abort", onAbort);
  }
}

export function normalizeMime(mime: string): string {
  return mime.toLowerCase().split(";")[0]?.trim() ?? "";
}

export function isBlobAttemptToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

export function isAllowedMime(mime: string): mime is AllowedMime {
  return ALLOWED_MIME_SET.has(normalizeMime(mime));
}

export function kindFromMime(mime: string): SourceKind | null {
  const m = normalizeMime(mime);
  if (!isAllowedMime(m)) return null;
  if (m === "application/pdf") return "pdf";
  if (
    m === "image/jpeg" ||
    m === "image/png" ||
    m === "image/webp" ||
    m === "image/gif"
  ) {
    return "image";
  }
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "document";
  }
  if (m === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return "presentation";
  }
  if (m.startsWith("text/")) return "text";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return null;
}

/** Strip path separators and collapse unsafe characters for blob path segments. */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() || "file";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  const sliced = cleaned.slice(0, 180);
  return sliced.length > 0 ? sliced : "file";
}

/**
 * Namespace: users/<userId>/reviewers/<reviewerId>/<uuid>-<safe-filename>
 * Client should use this (or an equivalent) when calling upload().
 */
export function buildBlobPathname(
  userId: string,
  reviewerId: string,
  filename: string,
): string {
  const id = crypto.randomUUID();
  return `users/${userId}/reviewers/${reviewerId}/${id}-${safeFilename(filename)}`;
}

export function parseUserReviewerFromPathname(
  pathname: string,
): { userId: string; reviewerId: string } | null {
  const match = USER_REVIEWER_PATH_RE.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return { userId: match[1], reviewerId: match[2] };
}

export function assertNamespacedPathname(
  pathname: string,
  opts: {
    userId?: string | null;
    reviewerId?: string | null;
  } = {},
): void {
  const parsed = parseUserReviewerFromPathname(pathname);
  if (!parsed) {
    throw new PublicError(
      "pathname must be namespaced as users/<userId>/reviewers/<reviewerId>/<uuid>-<filename>",
    );
  }
  if (
    opts.userId &&
    parsed.userId.toLowerCase() !== opts.userId.toLowerCase()
  ) {
    throw new PublicError("pathname userId does not match session user");
  }
  if (
    opts.reviewerId &&
    parsed.reviewerId.toLowerCase() !== opts.reviewerId.toLowerCase()
  ) {
    throw new PublicError("pathname reviewerId does not match clientPayload.reviewerId");
  }
}

/**
 * Check that a client-supplied URL is the canonical Vercel Blob URL for the
 * server-controlled pathname. Blob bytes are always read by pathname with
 * private Blob auth; this URL check prevents registration of arbitrary URLs.
 */
export function assertBlobUrlMatchesPathname(
  blobUrl: string,
  pathname: string,
): void {
  assertNamespacedPathname(pathname);

  let parsed: URL;
  try {
    parsed = new URL(blobUrl);
  } catch {
    throw new PublicError("blob_url must be a valid Vercel Blob URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !BLOB_HOST_RE.test(parsed.hostname)
  ) {
    throw new PublicError("blob_url must be a canonical Vercel Blob URL");
  }

  if (parsed.pathname !== `/${pathname}`) {
    throw new PublicError("blob_url pathname does not match blob_pathname");
  }
}

export type VerifiedBlobMetadata = Awaited<ReturnType<typeof head>>;

/**
 * Verify server-side Blob metadata before a source row is created. The
 * pathname is the identity; the client URL is only accepted when it names the
 * same Vercel Blob object and its metadata matches the declared MIME/limit.
 */
export async function verifyBlobMetadata(args: {
  blobUrl: string;
  pathname: string;
  mime: string;
  userId: string;
  reviewerId: string;
  maxBytes?: number;
  abortSignal?: AbortSignal;
}): Promise<VerifiedBlobMetadata> {
  assertNamespacedPathname(args.pathname, {
    userId: args.userId,
    reviewerId: args.reviewerId,
  });
  assertBlobUrlMatchesPathname(args.blobUrl, args.pathname);

  const metadata = await head(args.pathname, {
    token: process.env.BLOB_READ_WRITE_TOKEN,
    abortSignal: args.abortSignal,
  });
  if (metadata.pathname !== args.pathname) {
    throw new PublicError("Blob metadata pathname does not match blob_pathname");
  }

  const submittedStoreId = blobStoreId(args.blobUrl);
  const metadataStoreId = blobStoreId(metadata.url);
  if (!submittedStoreId || !metadataStoreId || submittedStoreId !== metadataStoreId) {
    throw new PublicError("blob_url does not belong to the configured Blob store");
  }

  const maxBytes = args.maxBytes ?? MAX_INGEST_BYTES;
  if (metadata.size > maxBytes) {
    throw new PublicError(`Blob exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB limit`);
  }

  const expectedMime = normalizeMime(args.mime);
  const actualMime = normalizeMime(metadata.contentType);
  if (actualMime !== expectedMime) {
    throw new PublicError(
      `Blob content type ${metadata.contentType} does not match declared mime ${args.mime}`,
    );
  }

  // A read-write token can inspect both public and private stores. Require a
  // private-authenticated read as part of registration so a public upload
  // cannot be persisted as a source. Request one byte and cancel immediately
  // to avoid buffering large media during this check.
  const accessCheck = await get(args.pathname, {
    access: "private",
    token: process.env.BLOB_READ_WRITE_TOKEN,
    headers: { Range: "bytes=0-0" },
    abortSignal: args.abortSignal,
  });
  const accessStatus = accessCheck?.statusCode as number | undefined;
  if (
    !accessCheck ||
    (accessStatus !== 200 && accessStatus !== 206) ||
    !accessCheck.stream
  ) {
    throw new PublicError("Blob is not privately accessible");
  }
  await accessCheck.stream.cancel();

  return metadata;
}

/** Fetch a private Blob stream by trusted pathname, never by client URL. */
export async function getPrivateBlob(
  pathname: string,
  maxBytes: number = MAX_INGEST_BYTES,
  abortSignal?: AbortSignal,
) {
  assertNamespacedPathname(pathname);
  const result = await get(pathname, {
    access: "private",
    useCache: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    abortSignal,
  });
  const resultStatus = result?.statusCode as number | undefined;
  if (
    !result ||
    (resultStatus !== 200 && resultStatus !== 206) ||
    !result.stream
  ) {
    throw new PublicError("Blob was not found or is not privately accessible");
  }
  if (result.blob.pathname !== pathname) {
    throw new PublicError("Blob response pathname does not match blob_pathname");
  }
  if (result.blob.size > maxBytes) {
    throw new PublicError(`Blob exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB limit`);
  }
  return result;
}

/** Read a private Blob stream with a hard byte cap. */
export async function readPrivateBlobBytes(
  pathname: string,
  maxBytes: number = MAX_INGEST_BYTES,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  const result = await getPrivateBlob(pathname, maxBytes, abortSignal);
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PublicError(
          `Blob response exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB limit`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (abortSignal?.aborted) {
    throw new PublicError("Source ingest cancelled");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type ClientUploadPayload = {
  reviewerId?: string;
  filename?: string;
  attemptToken?: string;
};

export function parseClientPayload(
  clientPayload: string | null,
): ClientUploadPayload {
  if (!clientPayload) return {};
  try {
    const parsed: unknown = JSON.parse(clientPayload);
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    return {
      reviewerId:
        typeof obj.reviewerId === "string" ? obj.reviewerId : undefined,
      filename: typeof obj.filename === "string" ? obj.filename : undefined,
      attemptToken:
        typeof obj.attemptToken === "string" &&
        obj.attemptToken.length <= MAX_BLOB_ATTEMPT_TOKEN_CHARS &&
        isBlobAttemptToken(obj.attemptToken)
          ? obj.attemptToken
          : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Run the official client-upload handshake (token mint + completed callback).
 * Caller must 401 before this when body.type is blob.generate-client-token
 * and there is no session. onUploadCompleted is intentionally a no-op.
 */
export async function handleClientUpload(args: {
  request: Request;
  body: HandleUploadBody;
  userId: string | null;
}): Promise<
  | { type: "blob.generate-client-token"; clientToken: string; attemptToken: string }
  | { type: "blob.upload-completed"; response: "ok" }
> {
  let body = args.body;
  let attemptToken: string | undefined;
  if (args.body.type === "blob.generate-client-token") {
    const payload = parseClientPayload(args.body.payload.clientPayload);
    // Mint the attempt identity on the server. It is returned once to the
    // authenticated browser and echoed on source registration; it is never
    // derived from pathname or filename and is not accepted from the Blob
    // provider callback as an authorization signal.
    // Never accept an attempt identity supplied by the browser. The server
    // owns the opaque lease token; the browser only receives this value in
    // the response and echoes it on the authenticated registration request.
    attemptToken = crypto.randomUUID();
    body = {
      ...args.body,
      payload: {
        ...args.body.payload,
        clientPayload: JSON.stringify({
          reviewerId: payload.reviewerId,
          filename: payload.filename,
          attemptToken,
        }),
      },
    };
  }
  const result = await handleUpload({
    request: args.request,
    body,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      if (!args.userId) {
        throw new PublicError("Unauthorized");
      }
      const payload = parseClientPayload(clientPayload);
      if (!payload.reviewerId) {
        throw new PublicError("reviewerId is required in clientPayload");
      }
      const reviewer = await getReviewer(payload.reviewerId, args.userId);
      if (!reviewer) {
        throw new PublicError("Reviewer not found");
      }
      assertNamespacedPathname(pathname, {
        userId: args.userId,
        reviewerId: payload.reviewerId,
      });

      // Reserve before the direct upload starts. This closes the window in
      // which reconciliation could delete a legitimate, delayed upload.
      const reservation = await reserveBlobForRegistration(
        args.userId,
        payload.reviewerId,
        pathname,
        payload.attemptToken ?? attemptToken,
        undefined,
        { allowTokenCreation: true },
      );
      if (reservation.outcome === "conflict") {
        throw new PublicError("Blob pathname is already reserved");
      }
      if (reservation.outcome === "busy") {
        throw new PublicError("Blob registration is already in progress");
      }

      return {
        allowedContentTypes: [...ALLOWED_MIME_TYPES],
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        addRandomSuffix: false,
        allowOverwrite: false,
        tokenPayload: clientPayload,
      };
    },
    // No DB writes — client POSTs metadata to /api/reviewers/[id]/sources.
    onUploadCompleted: async () => {},
  });
  if (result.type === "blob.generate-client-token") {
    return { ...result, attemptToken: attemptToken ?? crypto.randomUUID() };
  }
  return result;
}

/** Server-side put for tiny text only. Do not use for large PDF/video/audio. */
export async function putTinyTextBlob(
  pathname: string,
  body: string,
  contentType: string = "text/plain",
) {
  assertNamespacedPathname(pathname);
  return put(pathname, body, {
    access: "private",
    contentType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: false,
  });
}

const PROVIDER_OPERATION_ABORTED = Symbol("provider-operation-aborted");

export type BlobDeletionOutcome =
  | { status: "deleted"; retryable: false; inFlight: false }
  | { status: "not-found"; retryable: false; inFlight: false }
  | { status: "failed"; retryable: true; inFlight: false }
  | { status: "timeout"; retryable: true; inFlight: true }
  | { status: "aborted"; retryable: true; inFlight: true };

function isBlobNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    constructor?: { name?: unknown };
  };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const constructorName =
    typeof candidate.constructor?.name === "string" ? candidate.constructor.name : "";
  return (
    /blobnotfound|notfound|not_found/i.test(name) ||
    /blobnotfound|notfound|not_found/i.test(code) ||
    /blobnotfound|notfound|not_found/i.test(constructorName) ||
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    /(?:requested\s+)?blob(?:\s+object)?\s+(?:does\s+not\s+exist|not[\s_-]?found)|no such blob/i.test(message)
  );
}

/**
 * Delete a validated private Blob and preserve the provider result category.
 * A timeout/abort means the provider request may still be in flight, so its
 * caller must retain the deleting lease until the token-CAS retry boundary.
 */
export async function deleteBlobWithOutcome(
  urlOrPathname: string,
  owner: { userId: string; reviewerId: string },
  opts: {
    abortSignal?: AbortSignal;
    expectedEtag?: string;
    maxWaitMs?: number;
  } = {},
): Promise<BlobDeletionOutcome> {
  const pathname = urlOrPathname;
  try {
    if (/^https?:\/\//i.test(urlOrPathname)) {
      return { status: "failed", retryable: true, inFlight: false };
    }
    assertNamespacedPathname(pathname, owner);
  } catch {
    return { status: "failed", retryable: true, inFlight: false };
  }
  if (opts.abortSignal?.aborted) {
    return { status: "aborted", retryable: true, inFlight: true };
  }

  // AbortSignal support in a provider SDK is cooperative. Race both the
  // metadata lookup and delete call against the shared route signal and a
  // short local ceiling, so an SDK that ignores abort cannot strand the
  // request. The provider promise is still given the abort signal and its
  // rejection is observed, preventing an unhandled rejection after timeout.
  const controller = new AbortController();
  let callerAborted = false;
  let timedOut = false;
  const forwardAbort = () => {
    callerAborted = true;
    controller.abort(opts.abortSignal?.reason);
  };
  if (opts.abortSignal?.aborted) {
    callerAborted = true;
    controller.abort(opts.abortSignal.reason);
  } else {
    opts.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const maxWaitMs = Math.max(
    1,
    Math.min(opts.maxWaitMs ?? MAX_BLOB_DELETE_WAIT_MS, MAX_BLOB_DELETE_WAIT_MS),
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("blob deletion deadline exceeded"));
  }, maxWaitMs);
  const abortPromise = new Promise<typeof PROVIDER_OPERATION_ABORTED>((resolve) => {
    if (controller.signal.aborted) {
      resolve(PROVIDER_OPERATION_ABORTED);
      return;
    }
    controller.signal.addEventListener("abort", () => resolve(PROVIDER_OPERATION_ABORTED), {
      once: true,
    });
  });
  const raceProvider = async <T>(
    operation: () => Promise<T> | T,
  ): Promise<T | typeof PROVIDER_OPERATION_ABORTED> =>
    Promise.race([
      Promise.resolve()
        .then(operation)
        .catch((error: unknown) => {
          if (!isBlobNotFoundError(error)) {
            logRedactedError("Blob deletion failed", error, { pathname });
          }
          throw error;
        }),
      abortPromise,
    ]);

  try {
    let expectedEtag = opts.expectedEtag?.trim() || undefined;
    if (!expectedEtag) {
      const metadata = await raceProvider(() =>
        head(pathname, {
          token: process.env.BLOB_READ_WRITE_TOKEN,
          abortSignal: controller.signal,
        }),
      );
      if (metadata === PROVIDER_OPERATION_ABORTED) {
        return callerAborted
          ? { status: "aborted", retryable: true, inFlight: true }
          : { status: "timeout", retryable: true, inFlight: true };
      }
      if (metadata && typeof metadata === "object" && "etag" in metadata) {
        const etag = (metadata as { etag?: unknown }).etag;
        if (typeof etag === "string" && etag.trim().length > 0) {
          expectedEtag = etag.trim();
        }
      }
    }

    // Conditional deletion is the safety boundary that prevents an old
    // cleanup attempt from deleting a replacement upload. Never fall back to
    // an unconditional provider delete when metadata lacks a usable ETag.
    if (!expectedEtag) {
      return { status: "failed", retryable: true, inFlight: false };
    }

    const deleted = await raceProvider(() =>
      del(pathname, {
        token: process.env.BLOB_READ_WRITE_TOKEN,
        abortSignal: controller.signal,
        ifMatch: expectedEtag,
      }),
    );
    if (deleted === PROVIDER_OPERATION_ABORTED) {
      return callerAborted
        ? { status: "aborted", retryable: true, inFlight: true }
        : { status: "timeout", retryable: true, inFlight: true };
    }
    return { status: "deleted", retryable: false, inFlight: false };
  } catch (error) {
    // A previous attempt may have completed after its response was lost. A
    // provider-confirmed missing object is already in the desired state and
    // can safely advance the token-CAS lifecycle.
    if (callerAborted) {
      return { status: "aborted", retryable: true, inFlight: true };
    }
    if (timedOut) {
      return { status: "timeout", retryable: true, inFlight: true };
    }
    if (isBlobNotFoundError(error)) {
      return { status: "not-found", retryable: false, inFlight: false };
    }
    return { status: "failed", retryable: true, inFlight: false };
  } finally {
    clearTimeout(timeout);
    opts.abortSignal?.removeEventListener("abort", forwardAbort);
    controller.abort();
  }
}

/** Backwards-compatible boolean result for simple callers. */
export async function deleteBlob(
  urlOrPathname: string,
  owner: { userId: string; reviewerId: string },
  opts: {
    abortSignal?: AbortSignal;
    expectedEtag?: string;
    maxWaitMs?: number;
  } = {},
): Promise<boolean> {
  const outcome = await deleteBlobWithOutcome(urlOrPathname, owner, opts);
  return outcome.status === "deleted" || outcome.status === "not-found";
}

/**
 * Reference-aware provider deletion. The database claim is made before the
 * external call and leaves a durable lease; a fast provider failure may be
 * returned to `released`, while a timed-out/non-cooperative call keeps the
 * deleting lease until expiry so a replacement cannot race the old request.
 */
export async function deleteBlobIfUnreferenced(
  pathname: string,
  owner: { userId: string; reviewerId: string },
  opts: {
    allowDeletingSource?: boolean;
    abortSignal?: AbortSignal;
    maxWaitMs?: number;
  } = {},
): Promise<boolean> {
  try {
    assertNamespacedPathname(pathname, owner);
  } catch {
    return false;
  }
  if (opts.abortSignal?.aborted) return false;
  const cleanupDeadline = Date.now() + Math.max(
    1,
    Math.min(opts.maxWaitMs ?? MAX_BLOB_DELETE_WAIT_MS, MAX_BLOB_DELETE_WAIT_MS),
  );
  let claimed: Awaited<ReturnType<typeof claimBlobDeletion>> | boolean | typeof BLOB_OPERATION_ABORTED;
  try {
    claimed = await runBlobOperation({
      operation: () => claimBlobDeletion(
        owner.userId,
        owner.reviewerId,
        pathname,
        opts.allowDeletingSource ?? false,
      ),
      abortSignal: opts.abortSignal,
      deadline: cleanupDeadline,
    });
  } catch {
    return false;
  }
  if (claimed === BLOB_OPERATION_ABORTED || !claimed) return false;
  const attemptToken =
    typeof claimed === "object" ? claimed.attemptToken : null;
  const deletion = await deleteBlobWithOutcome(pathname, owner, {
    abortSignal: opts.abortSignal,
    maxWaitMs: Math.max(1, cleanupDeadline - Date.now()),
  });
  const deleted = deletion.status === "deleted" || deletion.status === "not-found";
  if (attemptToken) {
    if (deleted) {
      try {
        await runBlobOperation({
          operation: () => completeBlobDeletion(
            owner.userId,
            owner.reviewerId,
            pathname,
            attemptToken,
          ),
          abortSignal: opts.abortSignal,
          deadline: cleanupDeadline,
        });
      } catch {
        // The provider is already confirmed deleted. Keeping the deleting
        // lease is safe; a later reconciliation/CAS retry can finish DB
        // cleanup without allowing a replacement to be deleted.
      }
    } else if (
      deletion.status === "failed" &&
      Date.now() < cleanupDeadline &&
      !opts.abortSignal?.aborted
    ) {
      try {
        await runBlobOperation({
          operation: () => requeueBlobDeletion(
            owner.userId,
            owner.reviewerId,
            pathname,
            attemptToken,
          ),
          abortSignal: opts.abortSignal,
          deadline: cleanupDeadline,
        });
      } catch {
        // Leave the deleting lease in place when the retry state write cannot
        // be confirmed. Its expiry is the durable retry boundary.
      }
    }
  }
  return deleted;
}

export type BlobReconciliationResult = {
  examined: number;
  deleted: number;
  failed: number;
};

/**
 * Remove stale direct-upload objects that never became source rows. The
 * caller supplies the rows currently referenced by the authenticated owner;
 * the prefix is independently constrained to that same owner and reviewer.
 */
export async function reconcileUnregisteredBlobs(args: {
  userId: string;
  reviewerId: string;
  referencedPathnames: Iterable<string>;
  abortSignal?: AbortSignal;
  now?: Date;
  graceMs?: number;
}): Promise<BlobReconciliationResult> {
  const result: BlobReconciliationResult = {
    examined: 0,
    deleted: 0,
    failed: 0,
  };
  const now = args.now ?? new Date();
  const graceMs = args.graceMs ?? ORPHAN_BLOB_GRACE_MS;
  const cutoff = now.getTime() - Math.max(0, graceMs);
  const prefix = `users/${args.userId}/reviewers/${args.reviewerId}/`;
  let cursor: string | undefined;

  try {
    if (args.abortSignal?.aborted) return result;
    const referenced = new Set(args.referencedPathnames);
    const reconciliationDeadline = Date.now() + MAX_BLOB_DELETE_WAIT_MS;
    const reservations = await runBlobOperation({
      operation: () => listBlobReservationsForReviewer(args.reviewerId, args.userId),
      abortSignal: args.abortSignal,
      deadline: reconciliationDeadline,
    });
    if (reservations === BLOB_OPERATION_ABORTED) return result;
    for (const reservation of reservations) {
      // Any future lease is active protection. An expired deleting lease is
      // deliberately eligible for retry after a provider/DB failure; it must
      // not strand an orphan reservation forever.
      if (reservation.leaseExpiresAt.getTime() > now.getTime()) {
        referenced.add(reservation.pathname);
      }
    }
    do {
      const page = await runBlobOperation({
        operation: () => list({
          prefix,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
          token: process.env.BLOB_READ_WRITE_TOKEN,
          abortSignal: args.abortSignal,
        }),
        abortSignal: args.abortSignal,
        deadline: reconciliationDeadline,
      });
      if (page === BLOB_OPERATION_ABORTED) return result;

      for (const blob of page.blobs) {
        result.examined += 1;
        const parsed = parseUserReviewerFromPathname(blob.pathname);
        if (
          !parsed ||
          parsed.userId.toLowerCase() !== args.userId.toLowerCase() ||
          parsed.reviewerId.toLowerCase() !== args.reviewerId.toLowerCase() ||
          referenced.has(blob.pathname)
        ) {
          continue;
        }

        const uploadedAt = new Date(blob.uploadedAt);
        if (!Number.isFinite(uploadedAt.getTime()) || uploadedAt.getTime() > cutoff) {
          continue;
        }

        if (await deleteBlobIfUnreferenced(blob.pathname, {
          userId: args.userId,
          reviewerId: args.reviewerId,
        }, {
          allowDeletingSource: false,
          abortSignal: args.abortSignal,
          maxWaitMs: Math.max(1, reconciliationDeadline - Date.now()),
        })) {
          result.deleted += 1;
        } else {
          result.failed += 1;
        }
      }

      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch (error) {
    // Reconciliation is deliberately non-blocking for the source list. A
    // later authenticated request retries it, while logs remain redacted.
    logRedactedError("Blob reconciliation failed", error, {
      userId: args.userId,
      reviewerId: args.reviewerId,
    });
  }

  return result;
}

export type { HandleUploadBody };
