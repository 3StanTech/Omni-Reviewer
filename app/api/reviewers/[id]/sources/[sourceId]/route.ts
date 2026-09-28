import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  deleteBlobIfUnreferenced,
  getPrivateBlob,
  MAX_INGEST_BYTES,
  MAX_UPLOAD_BYTES,
} from "@/lib/blob";
import { db } from "@/lib/db";
import { createIngestBudget, ingestSource } from "@/lib/ingest";
import {
  beginSourceDeletion,
  deleteSourceForOwner,
  getReviewer,
  getSourceForReviewer,
  replaceFailedSourceIngest,
} from "@/lib/queries";
import { logRedactedError, PublicError, publicErrorMessage } from "@/lib/public-errors";
import { cappedBodyError, readCappedText } from "@/lib/request-body";
import { hasPageMarkers, pageCount, pageText, stripPageMarkers } from "@/lib/source-markers";
import { serializeSource } from "@/lib/source-response";
import type { Source, SourceKind } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RETRYABLE_SOURCE_KINDS = new Set<SourceKind>([
  "pdf",
  "text",
  "document",
  "presentation",
]);

/** Ready sources that can be re-read to add page or slide markers. */
const PAGED_SOURCE_KINDS = new Set<SourceKind>(["pdf", "presentation"]);

const PAGE_MARKERS_NOT_ELIGIBLE =
  "Only a ready PDF or PPTX without page numbers can be refreshed";
const PAGE_MARKERS_NOT_FOUND =
  "Page numbers could not be read from this file";

/** The retry body is at most `{ "reason": "page_markers" }`. */
const MAX_RETRY_BODY_BYTES = 1024;

type RouteContext = {
  params: Promise<{ id: string; sourceId: string }>;
};

/** Cap for a whole-source text view; a single page is always small. */
const MAX_SOURCE_TEXT_VIEW_CHARS = 20_000;

/**
 * The cited page's extracted text, for sources the browser cannot render as
 * a PDF page (pasted notes, DOCX, PPTX). Owner scoping happens before this.
 */
function sourceTextResponse(source: Source, pageParam: string | null): Response {
  const text = source.extractedText ?? "";
  const page = pageParam && /^\d{1,4}$/.test(pageParam) ? Number(pageParam) : null;
  const body = page === null || !hasPageMarkers(text)
    ? stripPageMarkers(text).slice(0, MAX_SOURCE_TEXT_VIEW_CHARS)
    : pageText(text, page);
  return NextResponse.json(
    { page, pageCount: pageCount(text), text: body, hasFile: Boolean(source.blobPathname) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

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
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "text") {
    return sourceTextResponse(source, url.searchParams.get("page"));
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

  let reason: string | null;
  try {
    reason = await readRetryReason(request);
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const refreshPageMarkers = reason === "page_markers";

  const source = await getSourceForReviewer(reviewerId, sourceId, userId);
  if (!source || source.deletingAt) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }
  if (refreshPageMarkers) {
    return refreshSourcePageMarkers(request, userId, reviewerId, source);
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

/**
 * Optional capped JSON body `{ reason }`. No body, or any other reason, is a
 * plain failed-source retry. Oversize or invalid JSON throws a PublicError.
 */
async function readRetryReason(request: Request): Promise<string | null> {
  const raw = await readCappedText(request, {
    maxBytes: MAX_RETRY_BODY_BYTES,
    tooLargeMessage: "Source retry request body exceeds the safe size limit",
    invalidMessage: "Invalid JSON body",
    allowEmpty: true,
  });
  if (!raw.trim()) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new PublicError("Invalid JSON body");
  }
  if (body && typeof body === "object" && "reason" in body) {
    const reason = (body as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}

function textFingerprint(text: string | null): string {
  return createHash("md5").update(text ?? "", "utf8").digest("hex");
}

/**
 * Re-read a ready PDF or PPTX from its stored blob so its text gains page
 * markers. The write is conditional on the row still holding the text and
 * blob that were read, so a concurrent delete or replace always wins.
 */
async function refreshSourcePageMarkers(
  request: Request,
  userId: string,
  reviewerId: string,
  source: NonNullable<Awaited<ReturnType<typeof getSourceForReviewer>>>,
) {
  const sourceId = source.id;
  if (
    source.ingestStatus !== "ready"
    || !PAGED_SOURCE_KINDS.has(source.kind)
    || hasPageMarkers(source.extractedText)
  ) {
    return NextResponse.json({ error: PAGE_MARKERS_NOT_ELIGIBLE }, { status: 409 });
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
        logRedactedError("Source page refresh failed", error, { reviewerId, sourceId });
      }
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // Never replace good ready text with a failed or unmarked read.
    if (ingest.ingestStatus !== "ready" || !hasPageMarkers(ingest.extractedText)) {
      return NextResponse.json({ error: PAGE_MARKERS_NOT_FOUND }, { status: 422 });
    }

    const result = await db.execute(sql`
      UPDATE sources AS s
      SET extracted_text = ${ingest.extractedText},
          error_message = NULL
      FROM reviewers AS r
      INNER JOIN topics AS t ON t.id = r.topic_id
      WHERE s.id = ${sourceId}
        AND s.reviewer_id = ${reviewerId}
        AND s.reviewer_id = r.id
        AND t.user_id = ${userId}
        AND s.ingest_status = 'ready'::ingest_status
        AND s.deleting_at IS NULL
        AND s.blob_pathname = ${source.blobPathname}
        AND md5(coalesce(s.extracted_text, '')) = ${textFingerprint(source.extractedText)}
        AND r.deleting_at IS NULL
        AND t.deleting_at IS NULL
      RETURNING s.id
    `);

    const row = await getSourceForReviewer(reviewerId, sourceId, userId);
    if (!row || row.deletingAt) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }
    if (result.rows.length === 0 && !hasPageMarkers(row.extractedText)) {
      return NextResponse.json(
        { error: "This source changed while refreshing. Try again." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      serializeSource(row, `/api/reviewers/${reviewerId}/sources/${row.id}`),
    );
  } finally {
    budget.dispose();
  }
}
