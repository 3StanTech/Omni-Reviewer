import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  deleteBlobIfUnreferenced,
  getPrivateBlob,
  MAX_INGEST_BYTES,
  MAX_UPLOAD_BYTES,
} from "@/lib/blob";
import { createIngestBudget, ingestSource } from "@/lib/ingest";
import {
  beginSourceDeletion,
  deleteSourceForOwner,
  getReviewer,
  getSourceForReviewer,
  replaceFailedSourceIngest,
} from "@/lib/queries";
import { logRedactedError, publicErrorMessage } from "@/lib/public-errors";
import { serializeSource } from "@/lib/source-response";
import type { SourceKind } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RETRYABLE_SOURCE_KINDS = new Set<SourceKind>([
  "pdf",
  "text",
  "document",
  "presentation",
]);

type RouteContext = {
  params: Promise<{ id: string; sourceId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId, sourceId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const source = await getSourceForReviewer(reviewerId, sourceId, userId);
  if (!source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }
  if (!source.blobPathname) {
    return NextResponse.json({ error: "Source file unavailable" }, { status: 404 });
  }

  const maxBytes =
    source.kind === "video" || source.kind === "audio"
      ? MAX_UPLOAD_BYTES
      : MAX_INGEST_BYTES;
  try {
    const blob = await getPrivateBlob(source.blobPathname, maxBytes, request.signal);
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Type": blob.blob.contentType || source.mime,
      "Content-Disposition": blob.blob.contentDisposition,
      "X-Content-Type-Options": "nosniff",
    });
    if (Number.isFinite(blob.blob.size)) {
      headers.set("Content-Length", String(blob.blob.size));
    }
    if (blob.blob.etag) headers.set("ETag", blob.blob.etag);
    return new Response(blob.stream, { status: 200, headers });
  } catch (error) {
    // Do not reveal whether a private object exists to a caller who passed a
    // source ID that is otherwise valid but whose blob is unavailable.
    logRedactedError("Private source retrieval failed", error, {
      reviewerId,
      sourceId,
    });
    return NextResponse.json({ error: "Source file unavailable" }, { status: 404 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId, sourceId } = await context.params;

  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const source = await beginSourceDeletion(sourceId, reviewerId, userId);
  if (!source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  // Keep the row when provider deletion fails so the user can retry and the
  // source remains available to reconciliation. Never silently orphan a row.
  const blobDeleted = source.blobPathname
    ? await deleteBlobIfUnreferenced(
        source.blobPathname,
        { userId, reviewerId },
        { allowDeletingSource: true, abortSignal: request.signal },
      )
    : true;
  if (!blobDeleted) {
    return NextResponse.json(
      { error: "Could not remove source file. Try again." },
      { status: 503 },
    );
  }

  const deleted = await deleteSourceForOwner(sourceId, reviewerId, userId);
  if (!deleted) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: deleted.id });
}

export async function POST(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId, sourceId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const source = await getSourceForReviewer(reviewerId, sourceId, userId);
  if (!source || source.deletingAt) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }
  if (source.ingestStatus !== "failed" || !RETRYABLE_SOURCE_KINDS.has(source.kind)) {
    return NextResponse.json(
      { error: "Only a failed text, PDF, or Office source can be retried" },
      { status: 409 },
    );
  }
  if (!source.blobPathname || !source.blobUrl) {
    return NextResponse.json({ error: "Source file unavailable" }, { status: 404 });
  }

  const budget = createIngestBudget(request.signal);
  try {
    let ingest;
    try {
      ingest = await ingestSource({
        mime: source.mime,
        blobUrl: source.blobUrl,
        blobPathname: source.blobPathname,
        filename: source.filename,
        signal: budget.signal,
        budget,
      });
      budget.throwIfExpired();
    } catch (error) {
      const message = publicErrorMessage(error, "Source ingest failed");
      if (message === "Source ingest failed") {
        logRedactedError("Source ingest failed", error, { reviewerId, sourceId });
      }
      return NextResponse.json({ error: message }, { status: 400 });
    }

    let row = await replaceFailedSourceIngest(userId, reviewerId, sourceId, {
      ingestStatus: ingest.ingestStatus,
      extractedText: ingest.extractedText,
      errorMessage: ingest.errorMessage,
    });
    if (!row) {
      row = await getSourceForReviewer(reviewerId, sourceId, userId);
    }
    if (!row || row.deletingAt) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }
    return NextResponse.json(
      serializeSource(row, `/api/reviewers/${reviewerId}/sources/${row.id}`),
    );
  } finally {
    budget.dispose();
  }
}
