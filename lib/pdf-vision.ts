import "server-only";

import { deflateSync } from "node:zlib";

import { PublicError } from "@/lib/public-errors";

export const MAX_PDF_PAGES = 100;
export const MAX_PDF_VISION_PAGES = 5;
export const MAX_PDF_VISION_IMAGES_PER_PAGE = 2;
export const MAX_PDF_IMAGE_PIXELS = 16_777_216;
export const MAX_PDF_VISION_BYTES = 12 * 1024 * 1024;

type RawImage = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
};

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.length);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length, false);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(output.length - 4, crc32(crcInput), false);
  return output;
}

/** Encode PDF.js raw page images without a native canvas dependency. */
export function encodePdfImageAsPng(image: RawImage): Uint8Array {
  const { width, height, channels } = image;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_PDF_IMAGE_PIXELS
  ) {
    throw new PublicError("PDF page image exceeds the safe pixel limit.");
  }
  if (channels !== 1 && channels !== 3 && channels !== 4) {
    throw new PublicError("PDF page image uses an unsupported color format.");
  }
  const rowBytes = width * channels;
  if (image.data.byteLength !== rowBytes * height) {
    throw new PublicError("PDF page image data is malformed.");
  }

  const scanlines = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const targetOffset = row * (rowBytes + 1);
    scanlines[targetOffset] = 0;
    scanlines.set(image.data.subarray(row * rowBytes, (row + 1) * rowBytes), targetOffset + 1);
  }
  const compressed = new Uint8Array(deflateSync(Buffer.from(scanlines)));
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width, false);
  headerView.setUint32(4, height, false);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const chunks = [
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ];
  const output = new Uint8Array(
    8 + chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  output.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
