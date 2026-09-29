/**
 * Image-only PDF writer. Each JPEG is embedded as-is (DCTDecode), one per page,
 * so no image library is needed. Isomorphic: no DOM and no Node APIs.
 * Inputs must be baseline RGB JPEGs; the browser re-encodes photos through a
 * canvas before calling this.
 */

export type JpegPdfPage = {
  jpeg: Uint8Array;
  width: number;
  height: number;
};

/** Mirrors `MAX_PDF_PAGES` in `lib/pdf-vision.ts`, which is server-only. */
export const MAX_JPEG_PDF_PAGES = 100;
/** A4 long edge in PDF points, so the MediaBox is a normal page size. */
const PAGE_LONG_EDGE_PT = 842;

const encoder = new TextEncoder();

function points(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function validate(pages: JpegPdfPage[]): void {
  if (pages.length === 0) throw new Error("A PDF needs at least one image.");
  if (pages.length > MAX_JPEG_PDF_PAGES) {
    throw new Error(`A PDF can hold at most ${MAX_JPEG_PDF_PAGES} images.`);
  }
  for (const page of pages) {
    if (
      !Number.isInteger(page.width) ||
      !Number.isInteger(page.height) ||
      page.width <= 0 ||
      page.height <= 0
    ) {
      throw new Error("Image sizes must be positive whole numbers.");
    }
    // JPEG start-of-image marker.
    if (page.jpeg.length < 4 || page.jpeg[0] !== 0xff || page.jpeg[1] !== 0xd8) {
      throw new Error("Image data is not a JPEG.");
    }
  }
}

/** Build a PDF 1.4 file with one full-page JPEG per page. */
export function buildImagePdf(pages: JpegPdfPage[]): Uint8Array {
  validate(pages);

  // Objects: 1 Catalog, 2 Pages, then Page, Contents and Image for each page.
  const objectCount = 2 + pages.length * 3;
  const chunks: Uint8Array[] = [];
  const offsets: number[] = new Array(objectCount + 1).fill(0);
  let length = 0;

  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    length += chunk.length;
  };
  const text = (value: string) => push(encoder.encode(value));
  const beginObject = (id: number) => {
    offsets[id] = length;
    text(`${id} 0 obj\n`);
  };

  // The binary comment tells transfer tools this file holds binary data.
  text("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  beginObject(1);
  text("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObject(2);
  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  text(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const scale = PAGE_LONG_EDGE_PT / Math.max(page.width, page.height);
    const width = points(page.width * scale);
    const height = points(page.height * scale);

    beginObject(pageId);
    text(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );

    const content = encoder.encode(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`);
    beginObject(contentId);
    text(`<< /Length ${content.length} >>\nstream\n`);
    push(content);
    text("\nendstream\nendobj\n");

    beginObject(imageId);
    text(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    );
    push(page.jpeg);
    text("\nendstream\nendobj\n");
  });

  const xrefOffset = length;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objectCount; id += 1) {
    xref += `${pad(offsets[id], 10)} 00000 n \n`;
  }
  text(xref);
  text(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const output = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}
