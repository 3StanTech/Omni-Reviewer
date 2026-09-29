/**
 * Browser-only: turn picked photos into one image-only PDF. Every photo is
 * decoded (HEIC through a lazily loaded decoder), downscaled and re-encoded as
 * an RGB JPEG, then packed by `buildImagePdf`. Nothing here imports server code.
 */

import { buildImagePdf, MAX_JPEG_PDF_PAGES, type JpegPdfPage } from "@/lib/jpeg-pdf";

/** Mirrors `MAX_VISION_IMAGE_BYTES` in the server vision route. */
export const MAX_VISION_IMAGE_BYTES = 800 * 1024;
/** Long edge of every image sent for reading. */
export const VISION_IMAGE_LONG_EDGE = 1600;
const FALLBACK_LONG_EDGE = 1280;
const FALLBACK_QUALITY = 0.72;
const JPEG_QUALITIES = [0.82, 0.72, 0.62];
const HEIC_TO_JPEG_QUALITY = 0.9;

export type EncodedJpeg = {
  blob: Blob;
  width: number;
  height: number;
};

export function isHeic(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  return /\.(heic|heif)$/i.test(file.name);
}

/** Scale down to fit the long edge. Never upscales. */
export function fitLongEdge(
  width: number,
  height: number,
  longEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Zero the size so the browser can free the pixel buffer right away. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("JPEG encoding failed"))),
      "image/jpeg",
      quality,
    );
  });
}

/**
 * Encode a canvas as a JPEG of at most `MAX_VISION_IMAGE_BYTES`. The ladder is
 * quality 0.82, 0.72, 0.62, then the same picture at 1280 px and quality 0.72.
 */
export async function encodeVisionJpeg(canvas: HTMLCanvasElement): Promise<EncodedJpeg> {
  for (const quality of JPEG_QUALITIES) {
    const blob = await canvasToBlob(canvas, quality);
    if (blob.size <= MAX_VISION_IMAGE_BYTES) {
      return { blob, width: canvas.width, height: canvas.height };
    }
  }

  const smaller = fitLongEdge(canvas.width, canvas.height, FALLBACK_LONG_EDGE);
  if (smaller.width < canvas.width || smaller.height < canvas.height) {
    const scaled = createCanvas(smaller.width, smaller.height);
    try {
      const context = scaled.getContext("2d");
      if (!context) throw new Error("Canvas is not available");
      context.imageSmoothingQuality = "high";
      context.drawImage(canvas, 0, 0, smaller.width, smaller.height);
      const blob = await canvasToBlob(scaled, FALLBACK_QUALITY);
      if (blob.size <= MAX_VISION_IMAGE_BYTES) {
        return { blob, width: smaller.width, height: smaller.height };
      }
    } finally {
      releaseCanvas(scaled);
    }
  }
  throw new Error("Image is too large to read");
}

/** Decode one photo into a JPEG page. The photo's EXIF orientation is applied. */
export async function toJpegPage(file: File): Promise<JpegPdfPage> {
  let source: Blob = file;
  if (isHeic(file)) {
    const { heicTo } = await import("heic-to");
    source = await heicTo({ blob: file, type: "image/jpeg", quality: HEIC_TO_JPEG_QUALITY });
  }

  const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  let canvas: HTMLCanvasElement | null = null;
  try {
    const size = fitLongEdge(bitmap.width, bitmap.height, VISION_IMAGE_LONG_EDGE);
    canvas = createCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available");
    // JPEG has no alpha, so transparent pixels would turn black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const encoded = await encodeVisionJpeg(canvas);
    return {
      jpeg: new Uint8Array(await encoded.blob.arrayBuffer()),
      width: encoded.width,
      height: encoded.height,
    };
  } finally {
    bitmap.close();
    if (canvas) releaseCanvas(canvas);
  }
}

function baseName(name: string): string {
  return name.replace(/\.[^./\\]+$/, "");
}

/** Sort by time taken (file modified time), then by name. */
function sortPhotos(files: File[]): File[] {
  return [...files].sort(
    (a, b) =>
      a.lastModified - b.lastModified ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

/**
 * Pack photos into one image-only PDF, one page per photo. Photos are converted
 * one at a time so only one decoded image is in memory at once.
 */
export async function buildPhotoSetFile(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<File> {
  if (files.length === 0) throw new Error("Choose at least one photo.");
  if (files.length > MAX_JPEG_PDF_PAGES) {
    throw new Error(`Choose up to ${MAX_JPEG_PDF_PAGES} photos at a time.`);
  }

  const sorted = sortPhotos(files);
  const pages: JpegPdfPage[] = [];
  onProgress?.(0, sorted.length);
  for (const file of sorted) {
    try {
      pages.push(await toJpegPage(file));
    } catch {
      throw new Error(`Could not read ${file.name}. Export it as JPG and try again.`);
    }
    onProgress?.(pages.length, sorted.length);
  }

  const first = baseName(sorted[0].name);
  const last = baseName(sorted[sorted.length - 1].name);
  const name = sorted.length === 1 ? `Photo ${first}.pdf` : `Photos ${first} to ${last}.pdf`;
  const bytes = buildImagePdf(pages);
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "application/pdf" });
}
