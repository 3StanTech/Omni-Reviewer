/**
 * Browser-only: render chosen PDF pages to JPEG images small enough to send for
 * reading. Pages render one at a time, so only one bitmap is alive at once.
 */

import {
  createCanvas,
  encodeVisionJpeg,
  releaseCanvas,
  VISION_IMAGE_LONG_EDGE,
} from "@/lib/photo-set";

export async function* renderPdfPages(
  data: ArrayBuffer | Uint8Array,
  pages: number[],
  signal?: AbortSignal,
): AsyncGenerator<{ page: number; blob: Blob }> {
  if (signal?.aborted) return;
  // PDF.js takes ownership of the bytes it is given, and callers read the same
  // file for several batches, so it gets its own copy.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  let canvas: HTMLCanvasElement | null = null;
  try {
    for (const page of pages) {
      if (signal?.aborted) return;
      if (!Number.isInteger(page) || page < 1 || page > pdf.numPages) {
        throw new Error(`Page ${page} is not in this file.`);
      }
      const pdfPage = await pdf.getPage(page);
      let task: { cancel: () => void; promise: Promise<void> } | null = null;
      const cancel = () => task?.cancel();
      try {
        if (signal?.aborted) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({
          scale: VISION_IMAGE_LONG_EDGE / Math.max(base.width, base.height),
        });
        if (canvas) releaseCanvas(canvas);
        canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        // The default "display" intent paces drawing with requestAnimationFrame,
        // which a hidden tab pauses, so reading would stall in the background.
        // "print" draws the same page content to this canvas without frame
        // pacing; annotations follow their Print flag instead of View.
        task = pdfPage.render({ canvas, viewport, intent: "print" });
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          await task.promise;
        } catch (error) {
          // A cancelled render is a stop request, not a failure.
          if (signal?.aborted) return;
          throw error;
        }
        const encoded = await encodeVisionJpeg(canvas);
        yield { page, blob: encoded.blob };
      } finally {
        signal?.removeEventListener("abort", cancel);
        pdfPage.cleanup();
      }
    }
  } finally {
    if (canvas) releaseCanvas(canvas);
    await pdf.loadingTask.destroy();
  }
}
