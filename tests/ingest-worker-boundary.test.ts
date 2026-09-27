import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { pageMarkerOverhead, splitPages } from "@/lib/source-markers";

type WorkerReply = { ok: true; text: string } | { ok: false; errorKind: string };

const workerPort = vi.hoisted(() => ({
  handler: null as null | ((request: unknown) => Promise<void>),
  replies: [] as unknown[],
}));
const pdfPages = vi.hoisted(() => ({ pages: [] as string[][] }));

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
vi.mock("unpdf", () => ({
  getResolvedPDFJS: async () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pdfPages.pages.length,
        getPage: async (pageNumber: number) => ({
          getTextContent: async () => ({
            items: pdfPages.pages[pageNumber - 1].map((str) => ({ str, hasEOL: false })),
          }),
        }),
      }),
    }),
  }),
}));

const root = path.resolve(__dirname, "..");

describe("killable ingest parser boundary", () => {
  it("terminates the worker on abort and does not relay parser messages", () => {
    const client = readFileSync(path.join(root, "lib/ingest-worker-client.ts"), "utf8");
    const worker = readFileSync(path.join(root, "lib/ingest-worker.ts"), "utf8");

    expect(client).toContain("new Worker(new URL(\"./ingest-worker.ts\", import.meta.url)");
    expect(client).toContain("worker.terminate()");
    expect(client).toContain("Source ingest cancelled");
    expect(client).not.toContain("result.error;");
    expect(worker).toContain("const PDF_TEXT_MAX_IMAGE_SIZE = 0");
    expect(worker).toContain("maxImageSize: PDF_TEXT_MAX_IMAGE_SIZE");
    expect(worker).not.toContain("MAX_PDF_IMAGE_PIXELS");
    expect(worker).toContain("1536 * 1024 * 1024");
    expect(worker).toContain("pages > MAX_PDF_PAGES");
    expect(worker).toContain("getPage(pageNumber)");
    expect(worker).toContain("MAX_PDF_TEXT_CHARS");
    expect(worker).toContain("MAX_PDF_OUTPUT_BYTES");
    expect(worker).toContain("MAX_PDF_WORKER_MEMORY_BYTES");
    expect(client).toContain("const PDF_WORKER_MAX_OLD_GENERATION_MB = 1024");
    expect(client).toContain("export const MAX_PARSER_WORKERS = 1");
    expect(client).toContain("killedParserError");
    expect(worker).not.toContain("extractText(pdf");
    expect(worker).toContain("errorKind");
    expect(worker).not.toContain("error: error instanceof Error ? error.message");
  });
});

describe("PDF text page markers", () => {
  let limits: { chars: number; bytes: number };

  beforeAll(async () => {
    const worker = await import("@/lib/ingest-worker");
    limits = { chars: worker.MAX_PDF_TEXT_CHARS, bytes: worker.MAX_PDF_OUTPUT_BYTES };
  });

  async function parse(pages: string[][]): Promise<WorkerReply> {
    pdfPages.pages = pages;
    workerPort.replies = [];
    await workerPort.handler?.({ kind: "pdf-text", bytes: new Uint8Array([1]) });
    return workerPort.replies[0] as WorkerReply;
  }

  it("marks every page, including blank ones, in PDF order", async () => {
    const reply = await parse([["Intro ", "text"], [], ["  Last"]]);
    expect(reply).toEqual({
      ok: true,
      text: "<<<page 1>>>\n\nIntro text\n\n<<<page 2>>>\n\n\n\n<<<page 3>>>\n\nLast",
    });
    if (reply.ok) {
      expect(splitPages(reply.text).map((page) => page.page)).toEqual([1, 2, 3]);
    }
  });

  it("returns empty text when no page has text", async () => {
    expect(await parse([[], [" "]])).toEqual({ ok: true, text: "" });
  });

  it("counts marker overhead toward the character limit", async () => {
    const overhead = pageMarkerOverhead(1, true) + pageMarkerOverhead(2, false);
    const half = (limits.chars - overhead) / 2;
    const fits = await parse([["x".repeat(half)], ["y".repeat(half)]]);
    expect(fits.ok).toBe(true);
    if (fits.ok) expect(fits.text.length).toBe(limits.chars);

    // The text alone is under the limit; only the markers push it over.
    expect(await parse([["x".repeat(half)], ["y".repeat(half + 1)]])).toEqual({
      ok: false,
      errorKind: "pdf-text-limit",
    });
  });
});
