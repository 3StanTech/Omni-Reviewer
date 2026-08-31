import { parentPort } from "node:worker_threads";

import { getResolvedPDFJS } from "unpdf";
import { officeFormatForKind, extractOfficeText } from "./office";
import { MAX_PDF_IMAGE_PIXELS, MAX_PDF_PAGES } from "./pdf-vision";

/** Keep parser output bounded before it crosses the worker boundary. */
export const MAX_PDF_TEXT_CHARS = 1_000_000;
export const MAX_PDF_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_WORKER_MEMORY_BYTES = 256 * 1024 * 1024;

type WorkerRequest = {
  kind: "office" | "pdf-text";
  format?: "document" | "presentation";
  bytes: Uint8Array;
};

if (!parentPort) {
  throw new Error("Ingest worker must run inside a worker thread");
}

function assertPdfWorkerMemory(): void {
  const usage = process.memoryUsage();
  if (usage.rss > MAX_PDF_WORKER_MEMORY_BYTES) {
    throw new Error("PDF_MEMORY_LIMIT");
  }
}

function pageTextFromContent(
  content: unknown,
  limits: { chars: number; outputBytes: number; hasPreviousPage: boolean },
): { text: string; chars: number; outputBytes: number } {
  if (!content || typeof content !== "object") {
    return { text: "", chars: limits.chars, outputBytes: limits.outputBytes };
  }
  const items = (content as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return { text: "", chars: limits.chars, outputBytes: limits.outputBytes };
  }

  const chunks: string[] = [];
  const encoder = new TextEncoder();
  let chars = limits.chars;
  let outputBytes = limits.outputBytes + (limits.hasPreviousPage ? 1 : 0);
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const value = (item as { str?: unknown }).str;
    if (typeof value !== "string") continue;
    const chunk = value + ((item as { hasEOL?: unknown }).hasEOL ? "\n" : "");
    const nextChars = chars + chunk.length;
    if (nextChars > MAX_PDF_TEXT_CHARS) throw new Error("PDF_TEXT_LIMIT");
    const nextOutputBytes = outputBytes + encoder.encode(chunk).byteLength;
    if (nextOutputBytes > MAX_PDF_OUTPUT_BYTES) {
      throw new Error("PDF_OUTPUT_LIMIT");
    }
    chunks.push(chunk);
    chars = nextChars;
    outputBytes = nextOutputBytes;
  }
  return { text: chunks.join(""), chars, outputBytes };
}

async function parsePdfText(bytes: Uint8Array): Promise<string> {
  assertPdfWorkerMemory();
  const { getDocument } = await getResolvedPDFJS();
  const loadingTask = getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
    disableAutoFetch: true,
    disableStream: true,
  }) as { promise: Promise<unknown>; destroy?: () => Promise<void> };
  let pdf: Awaited<typeof loadingTask.promise> | undefined;
  try {
    pdf = await loadingTask.promise;
    const pages = Number((pdf as { numPages?: unknown }).numPages);
    if (!Number.isSafeInteger(pages) || pages < 1) {
      throw new Error("PDF_PAGE_COUNT");
    }
    if (pages > MAX_PDF_PAGES) {
      throw new Error("PDF_PAGE_LIMIT");
    }

    const pageTexts: string[] = [];
    let totalChars = 0;
    let totalOutputBytes = 0;
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      assertPdfWorkerMemory();
      const page = await (pdf as {
        getPage: (page: number) => Promise<{
          getTextContent: () => Promise<unknown>;
          cleanup?: () => void | Promise<void>;
        }>;
      }).getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        assertPdfWorkerMemory();
        const parsedPage = pageTextFromContent(content, {
          chars: totalChars,
          outputBytes: totalOutputBytes,
          hasPreviousPage: pageTexts.length > 0,
        });
        pageTexts.push(parsedPage.text);
        totalChars = parsedPage.chars;
        totalOutputBytes = parsedPage.outputBytes;
      } finally {
        await page.cleanup?.();
      }
      assertPdfWorkerMemory();
    }
    return pageTexts.join("\n");
  } finally {
    try {
      await (pdf as { cleanup?: () => void | Promise<void> } | undefined)?.cleanup?.();
    } catch {
      // Worker termination is the hard cleanup boundary.
    }
    try {
      await loadingTask.destroy?.();
    } catch {
      // Worker termination is the hard cleanup boundary. Do not leak parser
      // diagnostics or provider details to the request process.
    }
  }
}

parentPort.on("message", async (request: WorkerRequest) => {
  try {
    const text = request.kind === "office"
      ? extractOfficeText(
          request.bytes,
          officeFormatForKind(request.format ?? "document"),
        )
      : await parsePdfText(request.bytes);
    parentPort?.postMessage({ ok: true, text });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      // Never relay parser Error.message across the public API boundary. The
      // request process maps this stable category to a safe message.
      errorKind:
        request.kind === "pdf-text" && error instanceof Error && error.message === "PDF_PAGE_LIMIT"
          ? "pdf-page-limit"
          : request.kind === "pdf-text" && error instanceof Error && error.message === "PDF_PAGE_COUNT"
            ? "pdf-page-count"
          : request.kind === "pdf-text" && error instanceof Error && error.message === "PDF_TEXT_LIMIT"
            ? "pdf-text-limit"
            : request.kind === "pdf-text" && error instanceof Error && error.message === "PDF_OUTPUT_LIMIT"
              ? "pdf-output-limit"
              : request.kind === "pdf-text" && error instanceof Error && error.message === "PDF_MEMORY_LIMIT"
                ? "pdf-memory-limit"
          : request.kind,
    });
  }
});
