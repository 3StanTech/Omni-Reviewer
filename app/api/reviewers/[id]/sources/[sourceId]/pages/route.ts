import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { visionReadPages } from "@/lib/ai";
import {
  GenerationError,
  parseProviderError,
  publicGenerationErrorMessage,
  toGenerationError,
} from "@/lib/generation-errors";
import {
  getReviewer,
  getSourceForReviewer,
  replaceSourceTextIfUnchanged,
  sourceTextFingerprint,
} from "@/lib/queries";
import { isPublicError, logRedactedError, publicErrorMessage } from "@/lib/public-errors";
import {
  MAX_VISION_BATCH_BYTES,
  MAX_VISION_BATCH_PAGES,
  MAX_VISION_IMAGE_BYTES,
  mergeVisionPages,
  parseVisionBatch,
  pendingVisionPages,
  VISION_PAGES_INSTRUCTION,
  visionPageSummary,
} from "@/lib/source-vision";
import type { Source } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Leaves time to merge and respond inside the 120 s function limit. */
const VISION_DEADLINE_MS = 110_000;
/** Multipart boundaries and field headers on top of the image bytes. */
const MAX_FORM_OVERHEAD_BYTES = 64 * 1024;

const NOT_ELIGIBLE = "Only a ready PDF can have its slide images read";
const SOURCE_CHANGED = "This source changed while reading. Try again.";
const NO_STORE = { "Cache-Control": "private, no-store" };

type RouteContext = {
  params: Promise<{ id: string; sourceId: string }>;
};

type Owned = { userId: string; reviewerId: string; sourceId: string; source: Source };

function isEligible(source: Source): source is Source & { blobPathname: string } {
  return source.kind === "pdf" && source.ingestStatus === "ready" && Boolean(source.blobPathname);
}

/**
 * Resolve the caller's own source. Another owner's source, a missing one and
 * one being deleted all answer the same 404 so existence never leaks.
 */
async function loadOwnedSource(context: RouteContext): Promise<Owned | Response> {
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
  return { userId, reviewerId, sourceId, source };
}

/** Pages of a ready PDF still waiting for their slide pictures to be read. */
export async function GET(_request: Request, context: RouteContext) {
  const owned = await loadOwnedSource(context);
  if (owned instanceof Response) return owned;
  if (!isEligible(owned.source)) {
    return NextResponse.json({ error: NOT_ELIGIBLE }, { status: 409 });
  }
  return NextResponse.json(visionPageSummary(owned.source.extractedText ?? ""), { headers: NO_STORE });
}

type Batch = { pages: number[]; images: Uint8Array[]; final: boolean; last: boolean };

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Parse and bound `page`, `image`, `final` and `last`. `last` marks a single
 * page's last allowed try. Returns a 400 response on any invalid field.
 */
async function readBatch(form: FormData, pageTotal: number): Promise<Batch | Response> {
  const pageFields = form.getAll("page");
  const imageFields = form.getAll("image");
  const finalField = form.get("final");
  const lastField = form.get("last");
  if (finalField !== null && finalField !== "1") return badRequest("Invalid final flag");
  if (lastField !== null && (lastField !== "1" || pageFields.length !== 1)) {
    return badRequest("Invalid last flag");
  }
  if (pageFields.length < 1 || pageFields.length > MAX_VISION_BATCH_PAGES) {
    return badRequest(`Send 1 to ${MAX_VISION_BATCH_PAGES} pages at a time`);
  }
  if (imageFields.length !== pageFields.length) {
    return badRequest("Send one image for each page");
  }

  const pages: number[] = [];
  for (const field of pageFields) {
    if (typeof field !== "string" || !/^\d{1,4}$/.test(field)) return badRequest("Invalid page number");
    const page = Number(field);
    if (page < 1 || page > pageTotal) return badRequest("Page number is out of range");
    if (pages.includes(page)) return badRequest("Each page can be sent once");
    pages.push(page);
  }

  let totalBytes = 0;
  for (const field of imageFields) {
    if (typeof field === "string") return badRequest("Each image must be a JPEG file");
    if (field.size > MAX_VISION_IMAGE_BYTES) return badRequest("An image exceeds the safe size limit");
    totalBytes += field.size;
  }
  if (totalBytes > MAX_VISION_BATCH_BYTES) return badRequest("The images exceed the safe batch size limit");

  const images: Uint8Array[] = [];
  for (const field of imageFields as File[]) {
    const bytes = new Uint8Array(await field.arrayBuffer());
    if (!isJpeg(bytes)) return badRequest("Each image must be a JPEG file");
    images.push(bytes);
  }
  return { pages, images, final: finalField === "1", last: lastField === "1" };
}

/**
 * Merge readings into the pages that are still pending and write the text
 * only if nobody changed it since `current` was read. Returns the pages
 * written and the row, or null on a fingerprint miss.
 */
async function writeReadings(
  owned: Owned,
  current: Source & { blobPathname: string },
  readings: ReadonlyMap<number, string>,
): Promise<{ row: Source; read: number[] } | null> {
  const text = current.extractedText ?? "";
  const stillPending = new Set(pendingVisionPages(text));
  const applicable = new Map([...readings].filter(([page]) => stillPending.has(page)));
  if (applicable.size === 0) return { row: current, read: [] };

  const row = await replaceSourceTextIfUnchanged({
    userId: owned.userId,
    reviewerId: owned.reviewerId,
    sourceId: owned.sourceId,
    blobPathname: current.blobPathname,
    expectedFingerprint: sourceTextFingerprint(current.extractedText),
    text: mergeVisionPages(text, applicable),
  });
  return row ? { row, read: [...applicable.keys()].sort((a, b) => a - b) } : null;
}

/**
 * Whether the provider refused this request's own content: a 4xx answer other
 * than quota (402, 429), or a reading too long to keep. Outages (5xx, network),
 * timeouts and our own errors are not, so they never settle a page.
 */
function isContentRejection(error: unknown, code: string): boolean {
  if (code === "rate_limited" || code === "payment_required") return false;
  if (code === "token_limit") return true;
  const status = parseProviderError(error).status;
  return status !== undefined && status >= 400 && status < 500 && status !== 402 && status !== 429;
}

/** Read one batch of rendered page images and merge the readings into the source text. */
export async function POST(request: Request, context: RouteContext) {
  const owned = await loadOwnedSource(context);
  if (owned instanceof Response) return owned;
  const { reviewerId, sourceId, userId } = owned;
  if (!isEligible(owned.source)) {
    return NextResponse.json({ error: NOT_ELIGIBLE }, { status: 409 });
  }

  // The declared length bounds what formData() will read, so check it first.
  const declared = request.headers.get("content-length");
  if (
    !declared
    || !/^\d+$/.test(declared)
    || Number(declared) > MAX_VISION_BATCH_BYTES + MAX_FORM_OVERHEAD_BYTES
  ) {
    return NextResponse.json(
      { error: "Slide images exceed the safe request size limit" },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Invalid form data");
  }

  // The upload can take a while; decide what is pending on fresh text.
  const current = await getSourceForReviewer(reviewerId, sourceId, userId);
  if (!current || current.deletingAt) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }
  if (!isEligible(current)) {
    return NextResponse.json({ error: NOT_ELIGIBLE }, { status: 409 });
  }
  const currentText = current.extractedText ?? "";
  const batch = await readBatch(form, visionPageSummary(currentText).pageTotal);
  if (batch instanceof Response) return batch;

  // Pages another tab already read cost nothing.
  const pending = new Set(pendingVisionPages(currentText));
  const wanted = batch.pages
    .map((page, index) => ({ page, bytes: batch.images[index]! }))
    .filter((entry) => pending.has(entry.page));
  if (wanted.length === 0) {
    return NextResponse.json(
      { read: [], missing: [], pending: [...pending], unreadable: [] },
      { headers: NO_STORE },
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) onAbort();
  else request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("slide reading deadline exceeded"));
  }, VISION_DEADLINE_MS);

  let output: string;
  /** Pages the provider refused on their last try; recorded as read with nothing. */
  let unreadable: number[] = [];
  try {
    output = await visionReadPages(
      wanted.map((entry) => ({ page: entry.page, mime: "image/jpeg" as const, bytes: entry.bytes })),
      VISION_PAGES_INSTRUCTION,
      { signal: controller.signal },
    );
  } catch (error) {
    const classified = timedOut
      ? new GenerationError("timeout", "Reading slide images timed out.", true, { cause: error })
      : toGenerationError(error);
    const parsed = parseProviderError(error);
    logRedactedError("Source ingest failed", error, {
      reviewerId,
      sourceId,
      providerStatus: parsed.status,
      providerCode: parsed.code,
      requestId: parsed.requestId,
      // The provider's own reason (redacted and capped by logRedactedError);
      // a 400 is otherwise invisible behind its classified code.
      providerMessage: parsed.message,
    });
    const message = publicGenerationErrorMessage(classified.code, classified.message)
      ?? "Could not read the slide images. Try again.";
    const quota = classified.code === "rate_limited" || classified.code === "payment_required";
    if (!(batch.last && !timedOut && !request.signal.aborted && isContentRejection(error, classified.code))) {
      return NextResponse.json(
        { error: message, code: classified.code },
        { status: quota ? 429 : 502 },
      );
    }
    // A page the provider keeps refusing would otherwise block its source for
    // good. Settle it like a page still missing on the final try.
    unreadable = wanted.map((entry) => entry.page);
    output = "";
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }

  const requested = wanted.map((entry) => entry.page);
  const readings = parseVisionBatch(output, requested);
  let missing = requested.filter((page) => !readings.has(page));
  if (batch.final || unreadable.length > 0) {
    // A page absent twice is recorded as read with nothing, so it is never re-sent.
    for (const page of missing) readings.set(page, "");
    missing = [];
  }

  try {
    let written = await writeReadings(owned, current, readings);
    if (!written) {
      // Someone changed the text meanwhile: merge again onto the fresh text,
      // without another model call, and give up after this one retry.
      const reloaded = await getSourceForReviewer(reviewerId, sourceId, userId);
      if (!reloaded || reloaded.deletingAt) {
        return NextResponse.json({ error: "Source not found" }, { status: 404 });
      }
      if (!isEligible(reloaded)) {
        return NextResponse.json({ error: SOURCE_CHANGED }, { status: 409 });
      }
      written = await writeReadings(owned, reloaded, readings);
      if (!written) {
        return NextResponse.json({ error: SOURCE_CHANGED }, { status: 409 });
      }
    }
    const nowPending = pendingVisionPages(written.row.extractedText ?? "");
    return NextResponse.json(
      {
        read: written.read.filter((page) => !unreadable.includes(page)),
        missing: missing.filter((page) => nowPending.includes(page)),
        pending: nowPending,
        unreadable: unreadable.filter((page) => written.read.includes(page)),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    // A PublicError here is the text size cap; anything else is unexpected.
    if (!isPublicError(error)) logRedactedError("Source ingest failed", error, { reviewerId, sourceId });
    return NextResponse.json(
      { error: publicErrorMessage(error, "Could not save the slide readings. Try again.") },
      { status: isPublicError(error) ? 422 : 500 },
    );
  }
}
