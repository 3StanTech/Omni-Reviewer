import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  deleteBlobIfUnreferenced,
  assertNamespacedPathname,
  isAllowedMime,
  kindFromMime,
  MAX_BLOB_DELETE_WAIT_MS,
  MAX_INGEST_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_BLOB_ATTEMPT_TOKEN_CHARS,
  MAX_SOURCE_BODY_BYTES,
  normalizeMime,
  reconcileUnregisteredBlobs,
  verifyBlobMetadata,
} from "@/lib/blob";
import { createIngestBudget, ingestSource } from "@/lib/ingest";
import {
  createSourceForOwner,
  getReviewer,
  getSourceForReviewer,
  listSourcesForUi,
  releaseBlobReservation,
  reserveBlobForRegistration,
} from "@/lib/queries";
import { readCappedJson } from "@/lib/request-body";
import {
  logRedactedError,
  publicErrorMessage,
} from "@/lib/public-errors";
import { serializeSource } from "@/lib/source-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const createSourceSchema = z.object({
  filename: z.string().trim().min(1, "filename is required").max(500),
  mime: z.string().trim().min(1, "mime is required").max(200),
  blob_url: z.string().url("blob_url must be a valid url"),
  blob_pathname: z.string().trim().min(1, "blob_pathname is required").max(1000),
  attempt_token: z
    .string()
    .trim()
    .min(16, "attempt_token is required")
    .max(MAX_BLOB_ATTEMPT_TOKEN_CHARS)
    .regex(/^[A-Za-z0-9_-]+$/, "attempt_token is invalid"),
}).strict();

type RouteContext = { params: Promise<{ id: string }> };

const CLEANUP_OPERATION_ABORTED = Symbol("cleanup-operation-aborted");

/** Race non-cancellable database cleanup against the same short deadline. */
async function runBoundedCleanupOperation<T>(args: {
  operation: () => Promise<T> | T;
  abortSignal?: AbortSignal;
  deadline: number;
}): Promise<T | typeof CLEANUP_OPERATION_ABORTED> {
  if (args.abortSignal?.aborted || Date.now() >= args.deadline) {
    return CLEANUP_OPERATION_ABORTED;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof CLEANUP_OPERATION_ABORTED>((resolve) => {
    onAbort = () => resolve(CLEANUP_OPERATION_ABORTED);
    args.abortSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => resolve(CLEANUP_OPERATION_ABORTED),
      Math.max(1, args.deadline - Date.now()),
    );
  });
  const operation = Promise.resolve()
    .then(args.operation)
    .catch((error: unknown) => {
      logRedactedError("Blob cleanup database operation failed", error);
      throw error;
    });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) args.abortSignal?.removeEventListener("abort", onAbort);
  }
}

async function cleanupUnregisteredBlob(
  pathname: string,
  owner: { userId: string; reviewerId: string },
  attemptToken: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const cleanupDeadline = Date.now() + MAX_BLOB_DELETE_WAIT_MS;
  let releaseResult: boolean | typeof CLEANUP_OPERATION_ABORTED | undefined;
  try {
    releaseResult = await runBoundedCleanupOperation({
      operation: () => releaseBlobReservation(
        owner.userId,
        owner.reviewerId,
        pathname,
        attemptToken,
      ),
      abortSignal,
      deadline: cleanupDeadline,
    });
  } catch (error) {
    // A failed release may still leave an expired reservation that the claim
    // below can safely take over. Keep cleanup best-effort and token-CASed.
    logRedactedError("Unregistered Blob reservation release failed", error, owner);
  }
  if (
    releaseResult === CLEANUP_OPERATION_ABORTED ||
    abortSignal?.aborted ||
    Date.now() >= cleanupDeadline
  ) {
    // Cleanup must never replace the original safe API error. The reservation
    // and source-less pathname remain auditable for reconciliation.
    logRedactedError("Unregistered Blob cleanup deferred", null, owner);
    return;
  }

  try {
    const deleted = await deleteBlobIfUnreferenced(pathname, owner, {
      abortSignal,
      maxWaitMs: Math.max(1, cleanupDeadline - Date.now()),
    });
    if (!deleted) {
      // The authenticated source-list reconciliation will retry after the
      // orphan grace period. Log only stable metadata when immediate cleanup
      // cannot be confirmed.
      logRedactedError("Unregistered Blob cleanup deferred", null, owner);
    }
  } catch (error) {
    // Cleanup must never replace the original safe API error. The reservation
    // and source-less pathname remain auditable for reconciliation.
    logRedactedError("Unregistered Blob cleanup failed", error, owner);
  }
}

export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const rows = await listSourcesForUi(reviewerId, userId);
  await reconcileUnregisteredBlobs({
    userId,
    reviewerId,
    referencedPathnames: rows.flatMap((row) => row.blobPathname ? [row.blobPathname] : []),
    abortSignal: request.signal,
  });
  return NextResponse.json(
    rows.map((row) =>
      serializeSource(
        row,
        row.blobPathname
          ? `/api/reviewers/${reviewerId}/sources/${row.id}`
          : null,
      ),
    ),
  );
}

export async function POST(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await readCappedJson(request, {
      maxBytes: MAX_SOURCE_BODY_BYTES,
      tooLargeMessage: "Source registration body exceeds the safe size limit",
    });
  } catch (error) {
    const message = publicErrorMessage(error, "Invalid JSON body");
    return NextResponse.json(
      { error: message },
      { status: /exceeds the safe size limit/i.test(message) ? 413 : 400 },
    );
  }

  const parsed = createSourceSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const mime = normalizeMime(parsed.data.mime);
  if (!isAllowedMime(mime)) {
    return NextResponse.json(
      { error: `Unsupported mime type: ${parsed.data.mime}` },
      { status: 400 },
    );
  }

  const kind = kindFromMime(mime);
  if (!kind) {
    return NextResponse.json(
      { error: `Unsupported mime type: ${parsed.data.mime}` },
      { status: 400 },
    );
  }

  const maxBytes =
    kind === "video" || kind === "audio"
      ? MAX_UPLOAD_BYTES
      : MAX_INGEST_BYTES;
  try {
    assertNamespacedPathname(parsed.data.blob_pathname, { userId, reviewerId });
  } catch (error) {
    return NextResponse.json(
      { error: publicErrorMessage(error, "Invalid private Blob identity") },
      { status: 400 },
    );
  }
  let reservation;
  try {
    reservation = await reserveBlobForRegistration(
      userId,
      reviewerId,
      parsed.data.blob_pathname,
      parsed.data.attempt_token,
    );
  } catch (error) {
    logRedactedError("Blob reservation failed", error, { reviewerId, userId });
    return NextResponse.json({ error: "Could not reserve source file" }, { status: 503 });
  }
  if (reservation.outcome === "registered" && reservation.sourceId) {
    const existing = await getSourceForReviewer(
      reviewerId,
      reservation.sourceId,
      userId,
    );
    if (existing) {
      return NextResponse.json(
        serializeSource(existing, `/api/reviewers/${reviewerId}/sources/${existing.id}`),
        { status: 200 },
      );
    }
    return NextResponse.json({ error: "Source registration is unavailable" }, { status: 409 });
  }
  if (reservation.outcome === "busy") {
    return NextResponse.json({ error: "Source registration is already in progress" }, { status: 409 });
  }
  if (reservation.outcome === "conflict") {
    return NextResponse.json({ error: "Blob pathname is already reserved" }, { status: 409 });
  }

  const budget = createIngestBudget(request.signal);
  try {
    await budget.run((signal) => verifyBlobMetadata({
        blobUrl: parsed.data.blob_url,
        pathname: parsed.data.blob_pathname,
        mime,
        userId,
        reviewerId,
        maxBytes,
        abortSignal: signal,
      }));
  } catch (err) {
    // Registration failed before a source row existed. Attempt immediate
    // cleanup; stale reconciliation on the next authenticated GET is the
    // durable retry path if the provider is unavailable now.
    await cleanupUnregisteredBlob(
      parsed.data.blob_pathname,
      { userId, reviewerId },
      parsed.data.attempt_token,
      budget.signal,
    );
    const message = publicErrorMessage(err, "Blob verification failed");
    if (message === "Blob verification failed") {
      logRedactedError("Blob verification failed", err, { reviewerId, userId });
    }
    budget.dispose();
    return NextResponse.json({ error: message }, { status: 400 });
  }

  let ingest;
  try {
    ingest = await ingestSource({
      mime,
      blobUrl: parsed.data.blob_url,
      blobPathname: parsed.data.blob_pathname,
      filename: parsed.data.filename,
      signal: budget.signal,
      budget,
    });
    // Some ingest subtypes intentionally persist a failed source for a
    // provider/parser error. A route deadline or client cancellation is
    // different: never publish a source row after the shared budget expired.
    budget.throwIfExpired();
  } catch (err) {
    await cleanupUnregisteredBlob(
      parsed.data.blob_pathname,
      { userId, reviewerId },
      parsed.data.attempt_token,
      budget.signal,
    );
    const message = publicErrorMessage(err, "Source ingest failed");
    if (message === "Source ingest failed") {
      logRedactedError("Source ingest failed", err, { reviewerId, userId });
    }
    budget.dispose();
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Prefer kind from mime classification; ingest echoes the same kind.
  let row;
  try {
    row = await createSourceForOwner(userId, {
      reviewerId,
      filename: parsed.data.filename,
      mime,
      kind,
      blobUrl: parsed.data.blob_url,
      blobPathname: parsed.data.blob_pathname,
      ingestStatus: ingest.ingestStatus,
      extractedText: ingest.extractedText,
      errorMessage: ingest.errorMessage,
    }, parsed.data.attempt_token);
  } catch (err) {
    // Metadata persistence failed; do not leave an unowned object behind.
    await cleanupUnregisteredBlob(
      parsed.data.blob_pathname,
      { userId, reviewerId },
      parsed.data.attempt_token,
      budget.signal,
    );
    logRedactedError("Could not save source", err, { reviewerId, userId });
    budget.dispose();
    return NextResponse.json({ error: "Could not save source" }, { status: 500 });
  }
  budget.dispose();
  return NextResponse.json(
    serializeSource(row, `/api/reviewers/${reviewerId}/sources/${row.id}`),
    { status: 201 },
  );
}
