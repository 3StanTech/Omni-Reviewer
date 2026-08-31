import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("killable ingest parser boundary", () => {
  it("terminates the worker on abort and does not relay parser messages", () => {
    const client = readFileSync(path.join(root, "lib/ingest-worker-client.ts"), "utf8");
    const worker = readFileSync(path.join(root, "lib/ingest-worker.ts"), "utf8");

    expect(client).toContain("new Worker(new URL(\"./ingest-worker.ts\", import.meta.url)");
    expect(client).toContain("worker.terminate()");
    expect(client).toContain("Source ingest cancelled");
    expect(client).not.toContain("result.error;");
    expect(worker).toContain("maxImageSize: MAX_PDF_IMAGE_PIXELS");
    expect(worker).toContain("pages > MAX_PDF_PAGES");
    expect(worker).toContain("getPage(pageNumber)");
    expect(worker).toContain("MAX_PDF_TEXT_CHARS");
    expect(worker).toContain("MAX_PDF_OUTPUT_BYTES");
    expect(worker).toContain("MAX_PDF_WORKER_MEMORY_BYTES");
    expect(worker).not.toContain("extractText(pdf");
    expect(worker).toContain("errorKind");
    expect(worker).not.toContain("error: error instanceof Error ? error.message");
  });
});
