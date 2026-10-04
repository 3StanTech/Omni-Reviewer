import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  getReviewer: vi.fn(),
  getSourceForReviewer: vi.fn(),
  replaceSourceTextIfUnchanged: vi.fn(),
  sourceTextFingerprint: vi.fn(),
}));
vi.mock("@/lib/ai", () => ({ visionReadPages: vi.fn() }));
vi.mock("@/lib/ingest", () => ({ MAX_EXTRACTED_TEXT_CHARS: 1_000_000 }));
vi.mock("@/lib/public-errors", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-errors")>("@/lib/public-errors");
  return { ...actual, logRedactedError: vi.fn() };
});

import { auth } from "@/auth";
import { visionReadPages } from "@/lib/ai";
import { GenerationError } from "@/lib/generation-errors";
import { logRedactedError } from "@/lib/public-errors";
import {
  getReviewer,
  getSourceForReviewer,
  replaceSourceTextIfUnchanged,
  sourceTextFingerprint,
} from "@/lib/queries";
import { joinPages, pageText, withSlideImageText } from "@/lib/source-markers";
import { MAX_VISION_BATCH_BYTES, MAX_VISION_IMAGE_BYTES } from "@/lib/source-vision";
import { GET, POST } from "@/app/api/reviewers/[id]/sources/[sourceId]/pages/route";

const authMock = auth as unknown as ReturnType<typeof vi.fn>;
const reviewerMock = getReviewer as unknown as ReturnType<typeof vi.fn>;
const sourceMock = getSourceForReviewer as unknown as ReturnType<typeof vi.fn>;
const replaceTextMock = replaceSourceTextIfUnchanged as unknown as ReturnType<typeof vi.fn>;
const fingerprintMock = sourceTextFingerprint as unknown as ReturnType<typeof vi.fn>;
const visionMock = visionReadPages as unknown as ReturnType<typeof vi.fn>;
const logMock = logRedactedError as unknown as ReturnType<typeof vi.fn>;

const context = { params: Promise.resolve({ id: "reviewer-1", sourceId: "source-1" }) };
const URL_BASE = "https://omni-reviewer.example/api/reviewers/reviewer-1/sources/source-1/pages";
const PATHNAME = "users/user-1/reviewers/reviewer-1/scan.pdf";

/** Pages 1 and 2 are image-only, page 3 has plenty of text. */
const SCAN_TEXT = joinPages(["", "", "t".repeat(400)]);

function pdfSource(extractedText: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "source-1",
    reviewerId: "reviewer-1",
    filename: "scan.pdf",
    mime: "application/pdf",
    kind: "pdf",
    blobUrl: "https://blob.example/private/scan.pdf",
    blobPathname: PATHNAME,
    ingestStatus: "ready",
    extractedText,
    errorMessage: null,
    deletingAt: null,
    createdAt: new Date("2026-09-29T00:00:00.000Z"),
    ...overrides,
  };
}

function jpeg(size = 16): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

async function batchRequest(
  entries: Array<{ page: string | number; image?: Uint8Array }>,
  options: { final?: boolean; last?: string; contentLength?: string | null } = {},
): Promise<Request> {
  const form = new FormData();
  for (const entry of entries) form.append("page", String(entry.page));
  for (const entry of entries) {
    if (entry.image) form.append("image", new Blob([entry.image.slice().buffer], { type: "image/jpeg" }), `p${entry.page}.jpg`);
  }
  if (options.final) form.append("final", "1");
  if (options.last !== undefined) form.append("last", options.last);
  const encoded = new Request(URL_BASE, { method: "POST", body: form });
  const body = await encoded.arrayBuffer();
  const headers = new Headers({ "content-type": encoded.headers.get("content-type")! });
  const contentLength = options.contentLength === undefined ? String(body.byteLength) : options.contentLength;
  if (contentLength !== null) headers.set("content-length", contentLength);
  return new Request(URL_BASE, { method: "POST", body, headers });
}

describe("source pages route", () => {
  beforeEach(() => {
    authMock.mockReset();
    reviewerMock.mockReset();
    sourceMock.mockReset();
    replaceTextMock.mockReset();
    fingerprintMock.mockReset();
    visionMock.mockReset();
    logMock.mockReset();
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    reviewerMock.mockResolvedValue({ id: "reviewer-1" });
    sourceMock.mockResolvedValue(pdfSource(SCAN_TEXT));
    fingerprintMock.mockImplementation((text: string | null) => `md5:${text ?? ""}`);
    replaceTextMock.mockImplementation(async (args: { text: string }) => pdfSource(args.text));
  });

  describe("GET", () => {
    it("requires a session", async () => {
      authMock.mockResolvedValue(null);
      const response = await GET(new Request(URL_BASE), context);
      expect(response.status).toBe(401);
    });

    it("answers 404 for another owner's, a missing, or a deleting source", async () => {
      reviewerMock.mockResolvedValueOnce(null);
      expect((await GET(new Request(URL_BASE), context)).status).toBe(404);
      sourceMock.mockResolvedValueOnce(null);
      expect((await GET(new Request(URL_BASE), context)).status).toBe(404);
      sourceMock.mockResolvedValueOnce(pdfSource(SCAN_TEXT, { deletingAt: new Date() }));
      expect((await GET(new Request(URL_BASE), context)).status).toBe(404);
    });

    it("refuses a source that is not a ready PDF with 409", async () => {
      sourceMock.mockResolvedValueOnce(pdfSource(SCAN_TEXT, { kind: "presentation" }));
      expect((await GET(new Request(URL_BASE), context)).status).toBe(409);
      sourceMock.mockResolvedValueOnce(pdfSource(SCAN_TEXT, { ingestStatus: "failed" }));
      expect((await GET(new Request(URL_BASE), context)).status).toBe(409);
    });

    it("lists pending pages without exposing the text", async () => {
      sourceMock.mockResolvedValue(pdfSource(joinPages([withSlideImageText("", "Read"), "", "t".repeat(400)])));
      const response = await GET(new Request(URL_BASE), context);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ pending: [2], pageTotal: 3, readCount: 1 });
    });
  });

  describe("POST", () => {
    it("requires a session", async () => {
      authMock.mockResolvedValue(null);
      const response = await POST(await batchRequest([{ page: 1, image: jpeg() }]), context);
      expect(response.status).toBe(401);
      expect(visionMock).not.toHaveBeenCalled();
    });

    it("answers 404 for another owner's source before reading the body", async () => {
      reviewerMock.mockResolvedValue(null);
      sourceMock.mockResolvedValue(null);
      const response = await POST(await batchRequest([{ page: 1, image: jpeg() }]), context);
      expect(response.status).toBe(404);
      expect(visionMock).not.toHaveBeenCalled();
      expect(replaceTextMock).not.toHaveBeenCalled();
    });

    it("refuses a non-PDF source with 409", async () => {
      sourceMock.mockResolvedValue(pdfSource("Pasted notes", { kind: "paste", mime: "text/plain", blobPathname: null }));
      const response = await POST(await batchRequest([{ page: 1, image: jpeg() }]), context);
      expect(response.status).toBe(409);
      expect(visionMock).not.toHaveBeenCalled();
    });

    it("rejects a missing or oversize content-length with 413", async () => {
      const missing = await POST(await batchRequest([{ page: 1, image: jpeg() }], { contentLength: null }), context);
      expect(missing.status).toBe(413);
      const oversize = await POST(
        await batchRequest([{ page: 1, image: jpeg() }], { contentLength: String(MAX_VISION_BATCH_BYTES + 65 * 1024) }),
        context,
      );
      expect(oversize.status).toBe(413);
      expect(visionMock).not.toHaveBeenCalled();
    });

    it("rejects an image that is not a JPEG with 400", async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      const response = await POST(await batchRequest([{ page: 1, image: png }]), context);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/JPEG/);
      expect(visionMock).not.toHaveBeenCalled();
    });

    it.each([
      ["a page out of range", [{ page: 10, image: jpeg() }]],
      ["page 0", [{ page: 0, image: jpeg() }]],
      ["a non-numeric page", [{ page: "one", image: jpeg() }]],
      ["a repeated page", [{ page: 1, image: jpeg() }, { page: 1, image: jpeg() }]],
      ["a page without its image", [{ page: 1, image: jpeg() }, { page: 2 }]],
      ["more than 8 pages", Array.from({ length: 9 }, (_v, i) => ({ page: i + 1, image: jpeg() }))],
      ["an oversize image", [{ page: 1, image: jpeg(MAX_VISION_IMAGE_BYTES + 1) }]],
    ])("rejects %s with 400", async (_label, entries) => {
      sourceMock.mockResolvedValue(pdfSource(joinPages(Array.from({ length: 9 }, () => ""))));
      const response = await POST(await batchRequest(entries), context);
      expect(response.status).toBe(400);
      expect(visionMock).not.toHaveBeenCalled();
    });

    it("skips pages that are already read without calling the model", async () => {
      sourceMock.mockResolvedValue(pdfSource(joinPages([withSlideImageText("", "Read"), "", "t".repeat(400)])));
      const response = await POST(await batchRequest([{ page: 1, image: jpeg() }]), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ read: [], missing: [], pending: [2], unreadable: [] });
      expect(visionMock).not.toHaveBeenCalled();
      expect(replaceTextMock).not.toHaveBeenCalled();
    });

    it("merges the pages the model read and reports a missing page for one retry", async () => {
      visionMock.mockResolvedValue("<<<page 1>>>\nAM envelope figure");
      const response = await POST(
        await batchRequest([{ page: 1, image: jpeg() }, { page: 2, image: jpeg() }]),
        context,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ read: [1], missing: [2], pending: [2], unreadable: [] });
      expect(visionMock).toHaveBeenCalledTimes(1);
      const [pages, instruction] = visionMock.mock.calls[0]!;
      expect(pages.map((entry: { page: number; mime: string }) => [entry.page, entry.mime]))
        .toEqual([[1, "image/jpeg"], [2, "image/jpeg"]]);
      expect(instruction).toContain("<<<page N>>>");
      const written = replaceTextMock.mock.calls[0]![0];
      expect(written).toMatchObject({
        userId: "user-1",
        reviewerId: "reviewer-1",
        sourceId: "source-1",
        blobPathname: PATHNAME,
        expectedFingerprint: `md5:${SCAN_TEXT}`,
      });
      expect(pageText(written.text, 1)).toBe("<<<slide image>>>\nAM envelope figure");
      expect(pageText(written.text, 2)).toBe("");
      expect(pageText(written.text, 3)).toBe("t".repeat(400));
    });

    it("records a page still missing on the final try as having no readable content", async () => {
      visionMock.mockResolvedValue("<<<page 1>>>\nAM envelope figure");
      const response = await POST(
        await batchRequest([{ page: 1, image: jpeg() }, { page: 2, image: jpeg() }], { final: true }),
        context,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ read: [1, 2], missing: [], pending: [], unreadable: [] });
      const written = replaceTextMock.mock.calls[0]![0];
      expect(pageText(written.text, 2)).toBe("<<<slide image>>>\n(no readable content)");
    });

    it("re-merges once onto fresh text after a fingerprint miss, without a second model call", async () => {
      const otherTab = joinPages([withSlideImageText("", "Other tab reading"), "", "t".repeat(400)]);
      sourceMock
        .mockResolvedValueOnce(pdfSource(SCAN_TEXT))
        .mockResolvedValueOnce(pdfSource(SCAN_TEXT))
        .mockResolvedValueOnce(pdfSource(otherTab));
      replaceTextMock
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(async (args: { text: string }) => pdfSource(args.text));
      visionMock.mockResolvedValue("<<<page 1>>>\nMine\n<<<page 2>>>\nCarrier diagram");

      const response = await POST(
        await batchRequest([{ page: 1, image: jpeg() }, { page: 2, image: jpeg() }]),
        context,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ read: [2], missing: [], pending: [], unreadable: [] });
      expect(visionMock).toHaveBeenCalledTimes(1);
      expect(replaceTextMock).toHaveBeenCalledTimes(2);
      const retry = replaceTextMock.mock.calls[1]![0];
      expect(retry.expectedFingerprint).toBe(`md5:${otherTab}`);
      expect(pageText(retry.text, 1)).toBe("<<<slide image>>>\nOther tab reading");
      expect(pageText(retry.text, 2)).toBe("<<<slide image>>>\nCarrier diagram");
    });

    it("gives up with 409 after a second fingerprint miss", async () => {
      replaceTextMock.mockResolvedValue(null);
      visionMock.mockResolvedValue("<<<page 1>>>\nMine");
      const response = await POST(await batchRequest([{ page: 1, image: jpeg() }]), context);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "This source changed while reading. Try again." });
      expect(visionMock).toHaveBeenCalledTimes(1);
      expect(replaceTextMock).toHaveBeenCalledTimes(2);
    });

    it("lets a delete during the read win", async () => {
      replaceTextMock.mockResolvedValue(null);
      sourceMock
        .mockResolvedValueOnce(pdfSource(SCAN_TEXT))
        .mockResolvedValueOnce(pdfSource(SCAN_TEXT))
        .mockResolvedValueOnce(pdfSource(SCAN_TEXT, { deletingAt: new Date() }));
      visionMock.mockResolvedValue("<<<page 1>>>\nMine");
      const response = await POST(await batchRequest([{ page: 1, image: jpeg() }]), context);
      expect(response.status).toBe(404);
    });

    it.each([
      ["rate_limited", 429],
      ["payment_required", 429],
      ["unavailable", 502],
    ] as const)("maps a %s model error to %i with its code", async (code, status) => {
      visionMock.mockRejectedValue(new GenerationError(code, "provider detail", code !== "payment_required"));
      const response = await POST(await batchRequest([{ page: 1, image: jpeg() }]), context);
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.code).toBe(code);
      expect(body.error).not.toContain("provider detail");
      expect(body.error).not.toContain("—");
      expect(replaceTextMock).not.toHaveBeenCalled();
      expect(logMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(GenerationError),
        expect.objectContaining({ reviewerId: "reviewer-1", sourceId: "source-1" }),
      );
      const logged = JSON.stringify(logMock.mock.calls[0]![2]);
      expect(logged).not.toContain("t".repeat(20));
    });

    describe("a single page's last try", () => {
      const rejected = () => Object.assign(new Error("Bad Request"), {
        statusCode: 400,
        responseBody: JSON.stringify({ error: { message: "Invalid image payload" } }),
      });

      it("settles a page the provider refuses as unreadable", async () => {
        visionMock.mockRejectedValue(rejected());
        const response = await POST(await batchRequest([{ page: 2, image: jpeg() }], { last: "1" }), context);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ read: [], missing: [], pending: [1], unreadable: [2] });
        expect(visionMock).toHaveBeenCalledTimes(1);
        const written = replaceTextMock.mock.calls[0]![0];
        expect(written.expectedFingerprint).toBe(`md5:${SCAN_TEXT}`);
        expect(pageText(written.text, 2)).toBe("<<<slide image>>>\n(no readable content)");
        expect(pageText(written.text, 1)).toBe("");
        // The provider's reason is still logged.
        expect(logMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.anything(),
          expect.objectContaining({ providerStatus: 400 }),
        );
      });

      it("settles a reading too long to keep", async () => {
        visionMock.mockRejectedValue(new GenerationError("token_limit", "Vision output exceeds the safe text limit.", false));
        const response = await POST(await batchRequest([{ page: 1, image: jpeg() }], { last: "1" }), context);
        expect(response.status).toBe(200);
        expect((await response.json()).unreadable).toEqual([1]);
      });

      it.each([
        ["a quota error", new GenerationError("rate_limited", "x", true), 429],
        ["a credits error", Object.assign(new Error("Payment Required"), { statusCode: 402 }), 429],
        ["a provider outage", Object.assign(new Error("Bad Gateway"), { statusCode: 502 }), 502],
        ["a timeout", new GenerationError("timeout", "Generation timed out.", true), 502],
        ["an error without a provider status", new Error("boom"), 502],
      ])("does not settle on %s", async (_label, error, status) => {
        visionMock.mockRejectedValue(error);
        const response = await POST(await batchRequest([{ page: 1, image: jpeg() }], { last: "1" }), context);
        expect(response.status).toBe(status);
        expect(replaceTextMock).not.toHaveBeenCalled();
      });

      it("does not settle a refused page that is not on its last try", async () => {
        visionMock.mockRejectedValue(rejected());
        const response = await POST(await batchRequest([{ page: 1, image: jpeg() }], { final: true }), context);
        expect(response.status).toBe(502);
        expect(replaceTextMock).not.toHaveBeenCalled();
      });

      it.each([
        ["more than one page", [{ page: 1, image: jpeg() }, { page: 2, image: jpeg() }], "1"],
        ["an invalid value", [{ page: 1, image: jpeg() }], "yes"],
      ])("rejects a last flag with %s", async (_label, entries, last) => {
        const response = await POST(await batchRequest(entries, { last }), context);
        expect(response.status).toBe(400);
        expect(visionMock).not.toHaveBeenCalled();
      });

      it("answers 404 for another owner's source before reading a last try", async () => {
        reviewerMock.mockResolvedValue(null);
        const response = await POST(await batchRequest([{ page: 1, image: jpeg() }], { last: "1" }), context);
        expect(response.status).toBe(404);
        expect(visionMock).not.toHaveBeenCalled();
      });
    });

    it("logs the provider's reason for a 400 without source text or keys", async () => {
      const providerError = Object.assign(new Error("Bad Request"), {
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { message: "Invalid image payload:\n could not parse image_url for key sk-or-v1-abc123" },
        }),
      });
      visionMock.mockRejectedValue(providerError);
      const response = await POST(await batchRequest([{ page: 1, image: jpeg() }]), context);
      expect(response.status).toBe(502);
      const details = logMock.mock.calls[0]![2] as Record<string, unknown>;
      expect(details).toMatchObject({ providerStatus: 400, reviewerId: "reviewer-1", sourceId: "source-1" });
      expect(details.providerMessage).toContain("Invalid image payload");

      const actual = await vi.importActual<typeof import("@/lib/public-errors")>("@/lib/public-errors");
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      actual.logRedactedError("Source ingest failed", providerError, {
        ...details,
        reviewerId: "11111111-1111-1111-1111-111111111111",
      });
      const logged = consoleError.mock.calls[0]![1] as Record<string, unknown>;
      expect(logged.providerMessage).toBe(
        "Invalid image payload: could not parse image_url for key sk-or-[redacted]",
      );
      expect(logged.providerStatus).toBe(400);
    });

    it("keeps a logged provider message to one capped line with image bytes redacted", async () => {
      const { redactProviderMessage } = await vi.importActual<typeof import("@/lib/public-errors")>(
        "@/lib/public-errors",
      );
      const message = redactProviderMessage(
        `line one\nline two data:image/jpeg;base64,/9j/4AAQ ${"A".repeat(150)} ${"x ".repeat(400)}`,
      );
      expect(message).not.toContain("\n");
      expect(message).not.toContain("/9j/");
      expect(message).not.toContain("A".repeat(100));
      expect(message.length).toBeLessThanOrEqual(300);
      expect(message.startsWith("line one line two data:[redacted] [redacted]")).toBe(true);
    });
  });
});
