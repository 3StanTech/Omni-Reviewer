import { describe, expect, it, vi } from "vitest";

import { buildImagePdf, MAX_JPEG_PDF_PAGES } from "@/lib/jpeg-pdf";
import { splitPages } from "@/lib/source-markers";

// The real pdf-text worker entry, run in-process: a Node Worker cannot load the
// TypeScript entry under Vitest, so its message handler is captured instead.
// unpdf is the real one, so the PDF really goes through PDF.js.
const workerPort = vi.hoisted(() => ({
  handler: null as null | ((request: unknown) => Promise<void>),
  replies: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("node:worker_threads", () => ({
  parentPort: {
    on: (_event: string, handler: (request: unknown) => Promise<void>) => {
      workerPort.handler = handler;
    },
    postMessage: (message: unknown) => {
      workerPort.replies.push(message);
    },
  },
}));

// Baseline RGB (YCbCr 4:2:0) JPEGs, made with ImageMagick. 16x8 and 6x12 pixels.
const LANDSCAPE_JPEG = base64Bytes(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAWEAEBAQAAAAAAAAAAAAAAAAAAFGH/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBv/EABcRAAMBAAAAAAAAAAAAAAAAAAAEFVL/2gAMAwEAAhEDEQA/AJGzSzQVsZTIys1o/9k=",
);
const PORTRAIT_JPEG = base64Bytes(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAMAAYDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAIG/8QAGRABAAIDAAAAAAAAAAAAAAAAAAMUFVJi/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwb/xAAXEQADAQAAAAAAAAAAAAAAAAAAAhQV/9oADAMBAAIRAxEAPwCMNyNzVh1EToOFCp//2Q==",
);

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function twoPagePdf(): Uint8Array {
  return buildImagePdf([
    { jpeg: LANDSCAPE_JPEG, width: 16, height: 8 },
    { jpeg: PORTRAIT_JPEG, width: 6, height: 12 },
  ]);
}

describe("buildImagePdf", () => {
  it("writes a PDF 1.4 file with exact cross-reference offsets", () => {
    const bytes = twoPagePdf();
    // Latin-1 keeps one character per byte, so string indexes equal byte offsets.
    const text = Buffer.from(bytes).toString("latin1");

    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);

    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 5)).toBe("xref\n");

    // Catalog, Pages, then three objects per page.
    const objectCount = 2 + 2 * 3;
    const entries = text.slice(startxref).split("\n").slice(3, 3 + objectCount);
    expect(text.slice(startxref).split("\n")[1]).toBe(`0 ${objectCount + 1}`);
    expect(text.slice(startxref).split("\n")[2]).toBe("0000000000 65535 f ");
    expect(entries).toHaveLength(objectCount);
    entries.forEach((entry, index) => {
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj\n`.length)).toBe(`${index + 1} 0 obj\n`);
    });
    expect(text).toContain(`/Size ${objectCount + 1}`);
  });

  it("scales the long edge to 842 pt, keeps the aspect, and embeds each JPEG untouched", () => {
    const bytes = twoPagePdf();
    const text = Buffer.from(bytes).toString("latin1");

    expect(text).toContain("/MediaBox [0 0 842 421]");
    expect(text).toContain("/MediaBox [0 0 421 842]");
    expect(text).toContain("q 842 0 0 421 0 0 cm /Im0 Do Q");
    expect(text).toContain("q 421 0 0 842 0 0 cm /Im0 Do Q");
    expect(text).toContain("/Subtype /Image /Width 16 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode");
    expect(text).toContain("/Subtype /Image /Width 6 /Height 12 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode");
    expect(text).toContain(Buffer.from(LANDSCAPE_JPEG).toString("latin1"));
    expect(text).toContain(Buffer.from(PORTRAIT_JPEG).toString("latin1"));
  });

  it("keeps the aspect for non-round sizes", () => {
    const bytes = buildImagePdf([{ jpeg: LANDSCAPE_JPEG, width: 1600, height: 1200 }]);
    expect(Buffer.from(bytes).toString("latin1")).toContain("/MediaBox [0 0 842 631.5]");
  });

  it("opens in PDF.js with the right page count, aspect ratios and no text", async () => {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(twoPagePdf());
    try {
      expect(pdf.numPages).toBe(2);
      const [first, second] = [await pdf.getPage(1), await pdf.getPage(2)];
      const a = first.getViewport({ scale: 1 });
      const b = second.getViewport({ scale: 1 });
      expect(a.width / a.height).toBeCloseTo(16 / 8, 3);
      expect(b.width / b.height).toBeCloseTo(6 / 12, 3);
      expect(Math.max(a.width, a.height)).toBeCloseTo(842, 3);
      expect(Math.max(b.width, b.height)).toBeCloseTo(842, 3);
      for (const page of [first, second]) {
        const content = await page.getTextContent();
        expect(content.items).toEqual([]);
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

  it("gives the pdf-text worker nothing but page markers", async () => {
    await import("@/lib/ingest-worker");
    workerPort.replies = [];
    await workerPort.handler?.({ kind: "pdf-text", bytes: twoPagePdf() });

    const reply = workerPort.replies[0] as { ok: boolean; text?: string };
    expect(reply.ok).toBe(true);
    // No text was extracted, so the output is one marker per page and nothing else.
    expect(reply.text).toEqual("<<<page 1>>>\n\n\n\n<<<page 2>>>\n\n");
    expect(splitPages(reply.text ?? "")).toEqual([
      { page: 1, text: "" },
      { page: 2, text: "" },
    ]);
  });

  it("rejects zero pages, more than 100 pages, and non-positive sizes", () => {
    const page = { jpeg: LANDSCAPE_JPEG, width: 16, height: 8 };
    expect(MAX_JPEG_PDF_PAGES).toBe(100);
    expect(() => buildImagePdf([])).toThrow();
    expect(() => buildImagePdf(Array.from({ length: 101 }, () => page))).toThrow();
    expect(() => buildImagePdf(Array.from({ length: 100 }, () => page))).not.toThrow();
    expect(() => buildImagePdf([{ ...page, width: 0 }])).toThrow();
    expect(() => buildImagePdf([{ ...page, height: -1 }])).toThrow();
    expect(() => buildImagePdf([{ ...page, width: Number.NaN }])).toThrow();
    expect(() => buildImagePdf([{ ...page, height: 2.5 }])).toThrow();
  });

  it("rejects bytes that are not a JPEG", () => {
    expect(() => buildImagePdf([{ jpeg: new Uint8Array([1, 2, 3, 4, 5]), width: 4, height: 4 }])).toThrow();
    expect(() => buildImagePdf([{ jpeg: new Uint8Array(), width: 4, height: 4 }])).toThrow();
  });
});
