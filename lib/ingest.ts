import "server-only";

import { runKillableParser } from "@/lib/ingest-worker-client";

import { visionReadImages } from "@/lib/ai";
import {
  assertBlobUrlMatchesPathname,
  assertNamespacedPathname,
  kindFromMime,
  MAX_INGEST_BYTES,
  normalizeMime,
  readPrivateBlobBytes,
} from "@/lib/blob";
import {
  logRedactedError,
  publicErrorMessage,
  PublicError,
} from "@/lib/public-errors";
import type { IngestStatus, SourceKind } from "@/lib/types";

/** Below this length, PDF text is treated as empty/tiny (likely scanned). */
const MIN_MEANINGFUL_PDF_TEXT = 40;

/** Prevent unexpectedly large extraction output from reaching the model. */
export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;

/** Leave a small response margin under the source-registration route limit. */
export const MAX_INGEST_DURATION_MS = 55_000;

const IMAGE_VISION_INSTRUCTION =
  "Read and transcribe all text visible in this image for study notes. " +
  "Preserve structure, headings, lists, equations, and labels. " +
    "If there is little text, describe the educational content clearly.";

export type IngestResult = {
  kind: SourceKind;
  ingestStatus: IngestStatus;
  extractedText: string | null;
  errorMessage: string | null;
};

export type IngestBudget = {
  signal: AbortSignal;
  run<T>(operation: (signal: AbortSignal) => Promise<T>, cleanup?: () => void | Promise<void>): Promise<T>;
  throwIfExpired(): void;
  dispose(): void;
};

export function createIngestBudget(parentSignal?: AbortSignal): IngestBudget {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let disposed = false;
  const onParentAbort = () => {
    cancelled = true;
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const cleanupTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("ingest deadline exceeded"));
  }, MAX_INGEST_DURATION_MS);

  const throwIfExpired = () => {
    if (!controller.signal.aborted) return;
    throw new PublicError(
      timedOut ? "Source ingest timed out" : cancelled ? "Source ingest cancelled" : "Source ingest aborted",
    );
  };

  const run = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    cleanup?: () => void | Promise<void>,
  ): Promise<T> => {
    throwIfExpired();
    let cleanupPromise: Promise<void> | undefined;
    const invokeCleanup = () => {
      cleanupPromise ??= Promise.resolve(cleanup?.())
        .catch((error) => {
          // Cleanup is best-effort at the library boundary; never let a
          // provider/parser cleanup rejection mask the caller's ingest error.
          logRedactedError("Ingest cleanup failed", error);
        })
        .then(() => undefined);
      return cleanupPromise;
    };
    const onAbort = () => {
      void invokeCleanup();
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await operation(controller.signal);
      throwIfExpired();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throwIfExpired();
      throw error;
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      if (controller.signal.aborted) await invokeCleanup();
    }
  };

  return {
    signal: controller.signal,
    run,
    throwIfExpired,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(cleanupTimer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function errorMessage(err: unknown, fallback: string): string {
  const message = publicErrorMessage(err, fallback);
  if (message === fallback && !(err instanceof PublicError)) {
    logRedactedError("Source ingest failed", err);
  }
  return message;
}

function ensureExtractedTextLimit(text: string): string {
  if (text.length > MAX_EXTRACTED_TEXT_CHARS) {
    throw new PublicError(
      `Extracted text exceeds the ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()} character limit`,
    );
  }
  return text;
}

async function ingestText(
  blobPathname: string,
  budget: IngestBudget,
): Promise<IngestResult> {
  const bytes = await budget.run((signal) =>
    readPrivateBlobBytes(blobPathname, MAX_INGEST_BYTES, signal),
  );
  const extractedText = new TextDecoder("utf-8").decode(bytes);
  return {
    kind: "text",
    ingestStatus: "ready",
    extractedText: ensureExtractedTextLimit(extractedText),
    errorMessage: null,
  };
}

async function ingestImage(
  blobPathname: string,
  mime: string,
  budget: IngestBudget,
): Promise<IngestResult> {
  try {
    const bytes = await budget.run((signal) =>
      readPrivateBlobBytes(blobPathname, MAX_INGEST_BYTES, signal),
    );
    const mediaType = normalizeMime(mime);
    const extractedText = await budget.run(
      (signal) =>
        visionReadImages(
          [{ mime: mediaType, bytes }],
          IMAGE_VISION_INSTRUCTION,
          { signal },
        ),
    );
    const boundedText = ensureExtractedTextLimit(extractedText);
    if (!boundedText.trim()) {
      return {
        kind: "image",
        ingestStatus: "failed",
        extractedText: null,
        errorMessage: "Vision readout returned empty text",
      };
    }
    return {
      kind: "image",
      ingestStatus: "ready",
      extractedText: boundedText,
      errorMessage: null,
    };
  } catch (err) {
    return {
      kind: "image",
      ingestStatus: "failed",
      extractedText: null,
      errorMessage: errorMessage(err, "Image vision readout failed"),
    };
  }
}

async function ingestPdf(
  blobPathname: string,
  budget: IngestBudget,
): Promise<IngestResult> {
  try {
    const bytes = await budget.run((signal) =>
      readPrivateBlobBytes(blobPathname, MAX_INGEST_BYTES, signal),
    );
    const merged = await budget.run((signal) => runKillableParser({
      kind: "pdf-text",
      bytes,
      signal,
    }));
    const cleaned = ensureExtractedTextLimit(
      merged.replace(/\u0000/g, "").trim(),
    );

    if (cleaned.length >= MIN_MEANINGFUL_PDF_TEXT) {
      return {
        kind: "pdf",
        ingestStatus: "ready",
        extractedText: cleaned,
        errorMessage: null,
      };
    }

    // The existing PDF.js image API enumerates/decodes an entire page before
    // returning it, so it cannot satisfy a killable hard image/pixel budget in
    // this Vercel route. Keep text PDFs supported and fail scanned PDFs
    // explicitly until a bounded worker renderer is available.
    throw new PublicError(
      "Scanned PDF vision fallback is unavailable in this deployment; upload a text PDF or paste the text.",
    );
  } catch (err) {
    return {
      kind: "pdf",
      ingestStatus: "failed",
      extractedText: null,
      errorMessage: errorMessage(err, "PDF text extraction failed"),
    };
  }
}

async function ingestOffice(
  blobPathname: string,
  kind: "document" | "presentation",
  budget: IngestBudget,
): Promise<IngestResult> {
  try {
    const bytes = await budget.run((signal) =>
      readPrivateBlobBytes(blobPathname, MAX_INGEST_BYTES, signal),
    );
    budget.throwIfExpired();
    const extractedText = ensureExtractedTextLimit(
      await budget.run((signal) => runKillableParser({
        kind: "office",
        format: kind,
        bytes,
        signal,
      })),
    );
    budget.throwIfExpired();
    return {
      kind,
      ingestStatus: "ready",
      extractedText,
      errorMessage: null,
    };
  } catch (err) {
    return {
      kind,
      ingestStatus: "failed",
      extractedText: null,
      errorMessage: errorMessage(err, `${kind === "document" ? "DOCX" : "PPTX"} extraction failed`),
    };
  }
}

/**
 * Classify mime → kind and populate extracted_text / ingest_status.
 * Video and audio are never transcribed (remain unprocessed).
 */
export async function ingestSource(args: {
  mime: string;
  blobUrl: string;
  blobPathname?: string;
  filename?: string;
  signal?: AbortSignal;
  budget?: IngestBudget;
}): Promise<IngestResult> {
  const kind = kindFromMime(args.mime);
  if (!kind) {
    return {
      kind: "text",
      ingestStatus: "failed",
      extractedText: null,
      errorMessage: `Unsupported mime type: ${args.mime}`,
    };
  }

  let blobPathname: string;
  try {
    blobPathname = args.blobPathname ?? new URL(args.blobUrl).pathname.slice(1);
    assertNamespacedPathname(blobPathname);
    assertBlobUrlMatchesPathname(args.blobUrl, blobPathname);
  } catch (err) {
    return {
      kind,
      ingestStatus: "failed",
      extractedText: null,
      errorMessage: errorMessage(err, "Invalid private Blob identity"),
    };
  }

  if (kind === "video" || kind === "audio") {
    return {
      kind,
      ingestStatus: "unprocessed",
      extractedText: null,
      errorMessage: null,
    };
  }

  const budget = args.budget ?? createIngestBudget(args.signal);
  const ownsBudget = !args.budget;
  try {
    if (kind === "text") {
      try {
        return await ingestText(blobPathname, budget);
      } catch (err) {
        return {
          kind,
          ingestStatus: "failed",
          extractedText: null,
          errorMessage: errorMessage(err, "Text extraction failed"),
        };
      }
    }

    if (kind === "image") {
      return await ingestImage(blobPathname, args.mime, budget);
    }

    if (kind === "document" || kind === "presentation") {
      return await ingestOffice(blobPathname, kind, budget);
    }

    return await ingestPdf(blobPathname, budget);
  } finally {
    if (ownsBudget) budget.dispose();
  }
}
