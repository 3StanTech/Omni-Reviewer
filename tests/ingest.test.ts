import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getBlob = vi.fn();

vi.mock("@vercel/blob", () => ({
  del: vi.fn(),
  get: (...args: unknown[]) => getBlob(...args),
  head: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@vercel/blob/client", () => ({
  handleUpload: vi.fn(),
}));

const visionReadImages = vi.fn();

vi.mock("@/lib/ai", () => ({
  visionReadImages: (...args: unknown[]) => visionReadImages(...args),
  generateTextFromPrompt: vi.fn(),
  generateStudyPack: vi.fn(),
}));

const getResolvedPDFJS = vi.fn();
const getDocument = vi.fn();
const extractText = vi.fn();
const extractImages = vi.fn();
const runKillableParser = vi.fn();

vi.mock("unpdf", () => ({
  getResolvedPDFJS: (...args: unknown[]) => getResolvedPDFJS(...args),
  extractText: (...args: unknown[]) => extractText(...args),
  extractImages: (...args: unknown[]) => extractImages(...args),
}));

vi.mock("@/lib/ingest-worker-client", () => ({
  runKillableParser: (...args: unknown[]) => runKillableParser(...args),
}));

import { ingestSource } from "@/lib/ingest";
import { PublicError } from "@/lib/public-errors";

const root = path.resolve(__dirname, "..");
const USER_ID = "11111111-1111-1111-1111-111111111111";
const REVIEWER_ID = "22222222-2222-2222-2222-222222222222";

function blobPath(filename: string): string {
  return `users/${USER_ID}/reviewers/${REVIEWER_ID}/33333333-3333-3333-3333-333333333333-${filename}`;
}

function blobUrl(pathname: string): string {
  return `https://store.private.blob.vercel-storage.com/${pathname}`;
}

function privateBlobResult(
  pathname: string,
  body: string | Uint8Array,
  contentType: string,
) {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    statusCode: 200,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    blob: {
      pathname,
      size: bytes.byteLength,
      contentType,
    },
  };
}

describe("ingest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getBlob.mockReset();
    visionReadImages.mockReset();
    getResolvedPDFJS.mockReset();
    getDocument.mockReset();
    getResolvedPDFJS.mockResolvedValue({
      getDocument: (...args: unknown[]) => getDocument(...args),
    });
    extractText.mockReset();
    extractImages.mockReset();
    runKillableParser.mockReset();
  });

  it("ingests a .txt body as ready with extracted_text", async () => {
    const body = "Lecture notes: mitochondria are the powerhouse.";
    const pathname = blobPath("notes.txt");
    getBlob.mockResolvedValue(privateBlobResult(pathname, body, "text/plain"));

    const result = await ingestSource({
      mime: "text/plain",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
      filename: "notes.txt",
    });

    expect(result).toEqual({
      kind: "text",
      ingestStatus: "ready",
      extractedText: body,
      errorMessage: null,
    });
    expect(getBlob).toHaveBeenCalledWith(
      pathname,
      expect.objectContaining({ access: "private", useCache: false }),
    );
  });

  it("does not persist or return an unexpected Blob error message", async () => {
    const pathname = blobPath("secret.txt");
    getBlob.mockRejectedValue(new Error("provider token secret details"));

    const result = await ingestSource({
      mime: "text/plain",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
      filename: "secret.txt",
    });

    expect(result).toMatchObject({
      kind: "text",
      ingestStatus: "failed",
      errorMessage: "Text extraction failed",
    });
    expect(result.errorMessage).not.toContain("provider token");
  });

  it("marks video mime as unprocessed with null text", async () => {
    const result = await ingestSource({
      mime: "video/mp4",
      blobUrl: blobUrl(blobPath("lecture.mp4")),
      blobPathname: blobPath("lecture.mp4"),
      filename: "lecture.mp4",
    });

    expect(result).toEqual({
      kind: "video",
      ingestStatus: "unprocessed",
      extractedText: null,
      errorMessage: null,
    });
    expect(visionReadImages).not.toHaveBeenCalled();
  });

  it("marks audio mime as unprocessed with null text", async () => {
    const result = await ingestSource({
      mime: "audio/mpeg",
      blobUrl: blobUrl(blobPath("lecture.mp3")),
      blobPathname: blobPath("lecture.mp3"),
      filename: "lecture.mp3",
    });

    expect(result).toEqual({
      kind: "audio",
      ingestStatus: "unprocessed",
      extractedText: null,
      errorMessage: null,
    });
    expect(visionReadImages).not.toHaveBeenCalled();
  });

  it("routes images through visionReadImages and returns ready text", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pathname = blobPath("diagram.png");
    getBlob.mockResolvedValue(privateBlobResult(pathname, pngBytes, "image/png"));
    visionReadImages.mockResolvedValue("Diagram: cell membrane structure");

    const result = await ingestSource({
      mime: "image/png",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
      filename: "diagram.png",
    });

    expect(visionReadImages).toHaveBeenCalledTimes(1);
    expect(visionReadImages).toHaveBeenCalledWith(
      [{ mime: "image/png", bytes: expect.any(Uint8Array) }],
      expect.stringMatching(/transcribe|text|image/i),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({
      kind: "image",
      ingestStatus: "ready",
      extractedText: "Diagram: cell membrane structure",
      errorMessage: null,
    });
  });

  it("propagates a caller abort to direct image vision and stops retries", async () => {
    const pathname = blobPath("abort.png");
    getBlob.mockResolvedValue(
      privateBlobResult(pathname, new Uint8Array([1, 2, 3]), "image/png"),
    );
    let providerSignal: AbortSignal | undefined;
    visionReadImages.mockImplementation(
      async (
        _images: unknown,
        _instruction: string,
        options: { signal?: AbortSignal },
      ) => {
        providerSignal = options.signal;
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("provider request aborted");
      },
    );
    const controller = new AbortController();
    const pending = ingestSource({
      mime: "image/png",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await pending;

    expect(providerSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      kind: "image",
      ingestStatus: "failed",
      errorMessage: "Source ingest cancelled",
    });
  });

  it("fails textless PDFs that have no embedded page images", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const pathname = blobPath("scan.pdf");
    getBlob.mockResolvedValue(
      privateBlobResult(pathname, pdfBytes, "application/pdf"),
    );
    runKillableParser.mockResolvedValue("");

    const result = await ingestSource({
      mime: "application/pdf",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
      filename: "scan.pdf",
    });

    expect(result.kind).toBe("pdf");
    expect(result.ingestStatus).toBe("failed");
    expect(result.errorMessage).toBeTruthy();
    expect(result.errorMessage).toMatch(/scanned PDF vision fallback is unavailable/i);
    expect(visionReadImages).not.toHaveBeenCalled();
  });

  it("fails scanned PDFs explicitly before any provider call", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const pathname = blobPath("scan.pdf");
    getBlob.mockResolvedValue(
      privateBlobResult(pathname, pdfBytes, "application/pdf"),
    );
    runKillableParser.mockResolvedValue(" ");

    const result = await ingestSource({
      mime: "application/pdf",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
      filename: "scan.pdf",
    });

    expect(result.ingestStatus).toBe("failed");
    expect(result.errorMessage).toMatch(/scanned PDF vision fallback is unavailable/i);
    expect(visionReadImages).not.toHaveBeenCalled();
  });

  it("cancels the killable PDF parser when the caller aborts", async () => {
    const pathname = blobPath("abort-scan.pdf");
    getBlob.mockResolvedValue(
      privateBlobResult(pathname, new Uint8Array([1]), "application/pdf"),
    );
    let parserSignal: AbortSignal | undefined;
    runKillableParser.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      parserSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new PublicError("Source ingest cancelled")), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = ingestSource({
      mime: "application/pdf",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 20 && !parserSignal; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(parserSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    const result = await pending;

    expect(parserSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      kind: "pdf",
      ingestStatus: "failed",
      errorMessage: "Source ingest cancelled",
    });
  });

  it("maps worker parser failures to a safe source error", async () => {
    const pathname = blobPath("abort-load.pdf");
    getBlob.mockResolvedValue(
      privateBlobResult(pathname, new Uint8Array([1]), "application/pdf"),
    );
    runKillableParser.mockRejectedValue(new Error("provider token secret"));
    const result = await ingestSource({
      mime: "application/pdf",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
    });
    expect(result).toMatchObject({
      kind: "pdf",
      ingestStatus: "failed",
      errorMessage: "PDF text extraction failed",
    });
    expect(result.errorMessage).not.toContain("provider token");
  });

  it("rejects PDFs beyond the bounded page limit before extraction", async () => {
    const pathname = blobPath("large-scan.pdf");
    getBlob.mockResolvedValue(
      privateBlobResult(pathname, new Uint8Array([1]), "application/pdf"),
    );
    runKillableParser.mockRejectedValue(new PublicError("PDF exceeds the 100-page limit"));

    const result = await ingestSource({
      mime: "application/pdf",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
      filename: "large-scan.pdf",
    });

    expect(result.ingestStatus).toBe("failed");
    expect(result.errorMessage).toMatch(/page limit/i);
  });

  it("rejects oversized embedded page images without calling vision", async () => {
    const pathname = blobPath("huge-scan.pdf");
    getBlob.mockResolvedValue(
      privateBlobResult(pathname, new Uint8Array([1]), "application/pdf"),
    );
    runKillableParser.mockRejectedValue(new PublicError("PDF page image exceeds the safe pixel limit."));

    const result = await ingestSource({
      mime: "application/pdf",
      blobUrl: blobUrl(pathname),
      blobPathname: pathname,
      filename: "huge-scan.pdf",
    });

    expect(result.ingestStatus).toBe("failed");
    expect(result.errorMessage).toMatch(/pixel limit/i);
    expect(visionReadImages).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary or non-Vercel blob URL before reading bytes", async () => {
    const pathname = blobPath("notes.txt");
    const result = await ingestSource({
      mime: "text/plain",
      blobUrl: "http://169.254.169.254/latest/meta-data",
      blobPathname: pathname,
    });

    expect(result.ingestStatus).toBe("failed");
    expect(result.errorMessage).toMatch(/vercel blob|canonical/i);
    expect(getBlob).not.toHaveBeenCalled();
  });

  it("does not import canvas or @napi-rs/canvas for PDF rasterization", () => {
    const source = readFileSync(path.join(root, "lib/ingest.ts"), "utf8");
    // Comments may mention the forbidden packages; only real imports fail.
    expect(source).not.toMatch(
      /(?:import|require)\s*(?:\{[^}]*\}\s*from\s*)?["']@napi-rs\/canvas["']/,
    );
    expect(source).not.toMatch(
      /(?:import|require)\s*(?:\{[^}]*\}\s*from\s*)?["']canvas["']/,
    );
    expect(source).not.toMatch(
      /from\s+["'](?:canvas|@napi-rs\/canvas)["']/,
    );
  });

  it("wires visionReadImages for the image path in source", () => {
    const source = readFileSync(path.join(root, "lib/ingest.ts"), "utf8");
    expect(source).toContain("visionReadImages");
    expect(source).toMatch(/kind === ["']image["']/);
  });
});
