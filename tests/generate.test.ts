import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SAMPLE_CARDED_JSON,
  SAMPLE_LOCKED_IN,
  SAMPLE_SUMMARY,
  SAMPLE_TEST_ME_JSON,
} from "./helpers";

vi.mock("server-only", () => ({}));

const generateText = vi.hoisted(() => vi.fn());
const generateObject = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateText(...args),
  generateObject: (...args: unknown[]) => generateObject(...args),
  NoObjectGeneratedError: class NoObjectGeneratedError extends Error {
    text?: string;
    response?: { modelId?: string };
    static isInstance(error: unknown): boolean {
      return (
        !!error &&
        typeof error === "object" &&
        (error as { name?: string }).name === "NoObjectGeneratedError"
      );
    }
    constructor(message?: string) {
      super(message);
      this.name = "NoObjectGeneratedError";
    }
  },
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => {
    return (modelId: string) => ({ modelId });
  },
}));

import {
  generateCarded,
  generateStudyPack,
  generateStudyPackStep,
  generateTextFromPrompt,
  visionReadImages,
} from "@/lib/ai";
import {
  MAX_VISION_OUTPUT_TOKENS,
  MAX_VISION_TEXT_CHARS,
} from "@/lib/learning-limits";
import { classifyGenerationError } from "@/lib/generation-errors";
import {
  cardedPrompt,
  lockedInPrompt,
  summaryPrompt,
  testMePrompt,
} from "@/lib/prompts";

const root = path.resolve(__dirname, "..");

describe("generate", () => {
  beforeEach(() => {
    generateText.mockReset();
    generateObject.mockReset();
    process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdefgh";
    process.env.AUTH_TRUST_HOST = "true";
    process.env.DATABASE_URL = "postgresql://user:password@example.test/db";
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
    process.env.AUTH_URL = "http://localhost:3000";
    process.env.OPENROUTER_API_KEY = "test-key-not-real";
    process.env.AI_MODEL_LOCKED_IN = "z-ai/glm-5.2:free";
    process.env.AI_MODEL_SUMMARY = "z-ai/glm-5.2:free";
    process.env.AI_MODEL_JSON = "z-ai/glm-5.2:free";
    process.env.AI_MODEL_FALLBACKS =
      "nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,openrouter/free";
  });

  it("caps vision output tokens and rejects oversized vision text", async () => {
    generateText.mockResolvedValue({
      text: "x".repeat(MAX_VISION_TEXT_CHARS + 1),
    });

    await expect(visionReadImages(
      [{ mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
      "Read the image",
    )).rejects.toThrow(/vision output exceeds/i);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: MAX_VISION_OUTPUT_TOKENS,
    });
  });

  it("calls pipeline in order Locked In → Summary → Test Me → Carded", async () => {
    const rawMarker = "RAW_SOURCE_UNIQUE_TOKEN_xyz";
    const extractedTexts = [
      { filename: "notes.txt", text: `Intro lecture. ${rawMarker}` },
    ];

    generateText
      .mockResolvedValueOnce({
        text: SAMPLE_LOCKED_IN,
        response: { modelId: "z-ai/glm-5.2:free" },
      })
      .mockResolvedValueOnce({
        text: SAMPLE_SUMMARY,
        response: { modelId: "z-ai/glm-5.2:free" },
      });

    generateObject
      .mockResolvedValueOnce({
        object: JSON.parse(SAMPLE_TEST_ME_JSON),
        response: { modelId: "z-ai/glm-5.2:free" },
      })
      .mockResolvedValueOnce({
        object: JSON.parse(SAMPLE_CARDED_JSON),
        response: { modelId: "z-ai/glm-5.2:free" },
      });

    expect(typeof generateTextFromPrompt).toBe("function");

    const pack = await generateStudyPack({ extractedTexts });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateObject).toHaveBeenCalledTimes(2);

    const textPrompts = generateText.mock.calls.map(
      (call) => (call[0] as { prompt: string }).prompt,
    );
    const objectPrompts = generateObject.mock.calls.map(
      (call) => (call[0] as { prompt: string }).prompt,
    );

    expect(textPrompts[0]).toBe(lockedInPrompt(extractedTexts));
    expect(textPrompts[1]).toBe(summaryPrompt(SAMPLE_LOCKED_IN));
    expect(objectPrompts[0]).toBe(testMePrompt(SAMPLE_LOCKED_IN));
    expect(objectPrompts[1]).toBe(cardedPrompt(SAMPLE_SUMMARY));

    // Summary is fed Locked In, not the raw sources.
    expect(textPrompts[1]).not.toContain(rawMarker);
    expect(textPrompts[1]).toContain(SAMPLE_LOCKED_IN);

    // Test Me also derives from Locked In only.
    expect(objectPrompts[0]).not.toContain(rawMarker);
    expect(objectPrompts[0]).toContain(SAMPLE_LOCKED_IN);

    // Carded derives from Summary only.
    expect(objectPrompts[1]).not.toContain(rawMarker);
    expect(objectPrompts[1]).toContain(SAMPLE_SUMMARY);
    expect(objectPrompts[1]).not.toBe(cardedPrompt(SAMPLE_LOCKED_IN));

    // Call order across both helpers: text, text, object, object.
    const textOrder = generateText.mock.invocationCallOrder;
    const objectOrder = generateObject.mock.invocationCallOrder;
    expect(textOrder[0]).toBeLessThan(textOrder[1]);
    expect(textOrder[1]).toBeLessThan(objectOrder[0]);
    expect(objectOrder[0]).toBeLessThan(objectOrder[1]);

    expect(pack.lockedIn).toBe(SAMPLE_LOCKED_IN);
    expect(pack.summary).toBe(SAMPLE_SUMMARY);
    expect(pack.testMe).toEqual(JSON.parse(SAMPLE_TEST_ME_JSON));
    expect(pack.carded).toEqual(JSON.parse(SAMPLE_CARDED_JSON));
  });

  it("rejects an empty structured Carded result before it can be persisted", async () => {
    generateObject.mockResolvedValue({
      object: [],
      response: { modelId: "z-ai/glm-5.2:free" },
    });

    await expect(generateCarded("# Summary\n\nMaterial")).rejects.toThrow(/carded/i);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("rejects structured output above the item cap", async () => {
    generateObject.mockResolvedValue({
      object: Array.from({ length: 101 }, (_, index) => ({
        id: `c${index}`,
        front: "Front",
        back: "Back",
      })),
      response: { modelId: "z-ai/glm-5.2:free" },
    });

    await expect(generateCarded("# Summary\n\nMaterial")).rejects.toThrow(/carded/i);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("generates one resumable step and preserves the provider model id", async () => {
    generateText.mockResolvedValueOnce({
      text: SAMPLE_LOCKED_IN,
      response: { modelId: "provider/actual-model" },
    });

    const result = await generateStudyPackStep({
      step: "locked_in",
      extractedTexts: [{ filename: "notes.txt", text: "source" }],
    });

    expect(result).toEqual({
      step: "locked_in",
      payload: { kind: "locked_in", content: SAMPLE_LOCKED_IN },
      modelUsed: "provider/actual-model",
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("maps retryable generation errors", () => {
    expect(
      classifyGenerationError({ statusCode: 429, message: "rate limit" }),
    ).toMatchObject({ code: "rate_limited", retryable: true });

    expect(
      classifyGenerationError({ statusCode: 503, message: "unavailable" }),
    ).toMatchObject({ code: "unavailable", retryable: true });

    expect(
      classifyGenerationError({
        statusCode: 402,
        message: "Payment Required",
      }),
    ).toMatchObject({ code: "payment_required", retryable: false });

    expect(
      classifyGenerationError({
        statusCode: 400,
        message: "maximum context length exceeded",
      }),
    ).toMatchObject({ code: "token_limit", retryable: false });

    expect(
      classifyGenerationError(new SyntaxError("Unexpected token")),
    ).toMatchObject({ code: "json_parse", retryable: true });

    expect(
      classifyGenerationError(new Error("request timed out")),
    ).toMatchObject({ code: "timeout", retryable: true });

    expect(classifyGenerationError(new Error("provider secret details"))).toEqual(
      expect.objectContaining({
        code: "unknown",
        message: "Generation failed unexpectedly. Try again shortly.",
        retryable: false,
      }),
    );
  });

  it.each([
    ["HTTP 500", { statusCode: 500, message: "internal server error" }, "unavailable"],
    ["HTTP 504", { statusCode: 504, message: "gateway timeout" }, "unavailable"],
    ["fetch failed", new TypeError("fetch failed"), "unavailable"],
    ["connection reset", Object.assign(new Error("socket closed"), { code: "ECONNRESET" }), "unavailable"],
    ["connection refused", Object.assign(new Error("socket closed"), { code: "ECONNREFUSED" }), "unavailable"],
    ["network unreachable", Object.assign(new Error("network error"), { code: "ENETUNREACH" }), "unavailable"],
    ["DNS retry", Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" }), "unavailable"],
    ["network timeout", Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" }), "timeout"],
  ])("classifies %s as a redacted retryable failure", (_name, error, code) => {
    const classified = classifyGenerationError(error);

    expect(classified).toMatchObject({ code, retryable: true });
    expect(classified.message).toBe(
      code === "timeout"
        ? "Generation timed out. Try again in a moment."
        : "The model provider is temporarily unavailable. Try again shortly.",
    );
    expect(classified.message).not.toContain("socket");
    expect(classified.message).not.toContain("ECONN");
  });

  it("does not retry arbitrary unknown errors", () => {
    expect(classifyGenerationError(new Error("programming failure"))).toEqual({
      code: "unknown",
      message: "Generation failed unexpectedly. Try again shortly.",
      retryable: false,
    });
  });

  it("GET views route does not import generate at module scope", () => {
    const viewsRoute = readFileSync(
      path.join(root, "app/api/reviewers/[id]/views/route.ts"),
      "utf8",
    );

    expect(viewsRoute).not.toMatch(
      /import\s+.*generateStudyPack|from\s+["']@\/lib\/ai["']/,
    );
    expect(viewsRoute).not.toMatch(/generateTextFromPrompt|generateStudyPack/);
    expect(viewsRoute).toMatch(/export async function GET/);
  });

  it("GET generation job route does not import generate at module scope", () => {
    const jobRoute = readFileSync(
      path.join(root, "app/api/reviewers/[id]/generation/[jobId]/route.ts"),
      "utf8",
    );

    expect(jobRoute).not.toMatch(
      /import\s+.*generateStudyPack|from\s+["']@\/lib\/ai["']/,
    );
    expect(jobRoute).not.toMatch(/generateTextFromPrompt|generateStudyPack/);
    expect(jobRoute).toMatch(/export async function GET/);
  });
});
