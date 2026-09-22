import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const createOpenRouter = vi.hoisted(() =>
  vi.fn(() => vi.fn((modelId: string, options: unknown) => ({ modelId, options }))),
);

vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter }));

import { envSchema } from "@/lib/env";
import {
  classifyGenerationError,
  parseProviderError,
  publicGenerationErrorMessage,
} from "@/lib/generation-errors";
import {
  assertFallbackModelIds,
  assertPrimaryModelId,
  getOpenRouter,
  isAllowedFallbackModelId,
  isPinnedFreeModelId,
  parseFallbackModels,
} from "@/lib/openrouter";
import {
  PROMPT_LIMITS,
  PromptInputLimitError,
  lockedInPrompt,
  summaryPrompt,
  validatePromptSources,
} from "@/lib/prompts";
import { isSafeMarkdownUrl, sanitizeMarkdownUrl } from "@/lib/utils";
import { serializeGenerationJob } from "@/lib/generation-jobs";
import { logRedactedError } from "@/lib/public-errors";

const root = path.resolve(__dirname, "..");

describe("Wave 1C contracts", () => {
  it("validates the complete server environment and rejects paid model ids", () => {
    const valid = {
      AUTH_SECRET: "a sufficiently long secret 0123456789",
      AUTH_TRUST_HOST: "true",
      AUTH_URL: "https://omni-reviewer.example",
      DATABASE_URL: "postgresql://user:password@example.test/db",
      BLOB_READ_WRITE_TOKEN: "blob-token",
      OPENROUTER_API_KEY: "sk-or-v1-test-key",
      AI_MODEL_LOCKED_IN: "provider/writer:free",
      AI_MODEL_SUMMARY: "provider/summary:free",
      AI_MODEL_JSON: "provider/json:free",
      AI_MODEL_VISION: "provider/vision:free",
      AI_MODEL_FALLBACKS: "provider/fallback-a:free,openrouter/free",
    };

    expect(envSchema.safeParse(valid).success).toBe(true);
    const withDefaults = envSchema.safeParse({
      AUTH_SECRET: valid.AUTH_SECRET,
      AUTH_TRUST_HOST: "",
      DATABASE_URL: valid.DATABASE_URL,
      BLOB_READ_WRITE_TOKEN: valid.BLOB_READ_WRITE_TOKEN,
      OPENROUTER_API_KEY: valid.OPENROUTER_API_KEY,
      AI_MODEL_LOCKED_IN: "",
      AI_MODEL_SUMMARY: "",
      AI_MODEL_JSON: "",
      AI_MODEL_VISION: "",
      AI_MODEL_FALLBACKS: "",
    });
    expect(withDefaults.success).toBe(true);
    if (withDefaults.success) {
      expect(withDefaults.data.AUTH_TRUST_HOST).toBe("true");
      expect(withDefaults.data.AI_MODEL_LOCKED_IN).toContain(":free");
      expect(withDefaults.data.AI_MODEL_FALLBACKS).toContain("openrouter/free");
    }
    expect(
      envSchema.safeParse({ ...valid, AI_MODEL_JSON: "provider/paid-model" })
        .success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...valid, AI_MODEL_FALLBACKS: "openrouter/auto" })
        .success,
    ).toBe(false);
    expect(envSchema.safeParse({ ...valid, AUTH_SECRET: "too-short" }).success).toBe(false);
  });

  it("rejects auto and paid model ids for both primary and fallback config", () => {
    expect(isPinnedFreeModelId("provider/model:free")).toBe(true);
    expect(isPinnedFreeModelId("openrouter/auto:free")).toBe(false);
    expect(isAllowedFallbackModelId("openrouter/free")).toBe(true);
    expect(isAllowedFallbackModelId("provider/paid-model")).toBe(false);
    expect(() => assertPrimaryModelId("openrouter/auto")).toThrow(/not allowed/);
    expect(() => assertPrimaryModelId("provider/paid-model")).toThrow(/paid/);
    expect(() => assertFallbackModelIds(["openrouter/auto:free"])).toThrow(
      /not allowed/,
    );
    expect(assertFallbackModelIds(["provider/model:free", "openrouter/free"])).toEqual([
      "provider/model:free",
      "openrouter/free",
    ]);
    expect(parseFallbackModels("provider/model:free,openrouter/free")).toEqual([
      "provider/model:free",
      "openrouter/free",
    ]);
  });

  it("builds provider configuration from the validated runtime environment", () => {
    process.env.AUTH_SECRET = "runtime-test-secret-0123456789abcdefgh";
    process.env.AUTH_TRUST_HOST = "true";
    process.env.AUTH_URL = "https://omni-reviewer.example";
    process.env.DATABASE_URL = "postgresql://user:password@example.test/db";
    process.env.BLOB_READ_WRITE_TOKEN = "blob-token";
    process.env.OPENROUTER_API_KEY = "runtime-openrouter-key";
    process.env.AI_MODEL_LOCKED_IN = "provider/locked:free";
    process.env.AI_MODEL_SUMMARY = "provider/summary:free";
    process.env.AI_MODEL_JSON = "provider/json:free";
    process.env.AI_MODEL_VISION = "provider/vision:free";
    process.env.AI_MODEL_FALLBACKS = "provider/fallback:free,openrouter/free";

    getOpenRouter();

    expect(createOpenRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "runtime-openrouter-key",
        appUrl: "https://omni-reviewer.example",
        headers: expect.objectContaining({
          "HTTP-Referer": "https://omni-reviewer.example",
        }),
        extraBody: expect.objectContaining({
          models: [],
        }),
      }),
    );
  });

  it("does not fall back to the legacy AI_MODEL variable", () => {
    const aiSource = readFileSync(path.join(root, "lib/ai.ts"), "utf8");
    expect(aiSource).not.toContain("process.env.AI_MODEL");
  });

  it("rejects oversized individual and combined source inputs without truncating", () => {
    const tooLarge = "x".repeat(PROMPT_LIMITS.maxSourceTextChars + 1);
    expect(() => validatePromptSources([{ filename: "notes.txt", text: tooLarge }]))
      .toThrow(PromptInputLimitError);

    const sources = [
      { filename: "one.txt", text: "x".repeat(160_000) },
      { filename: "two.txt", text: "x".repeat(160_000) },
      { filename: "three.txt", text: "x".repeat(160_000) },
      { filename: "four.txt", text: "x".repeat(120_000) },
    ];
    expect(() => validatePromptSources(sources)).toThrow(
      /combined extracted text exceeds/,
    );
  });

  it("keeps ordinary prompts stable while enforcing the final prompt bound", () => {
    const source = [{ filename: "notes.txt", text: "  Keep this text.  " }];
    expect(lockedInPrompt(source)).toContain("Keep this text.");
    expect(() => summaryPrompt("x".repeat(PROMPT_LIMITS.maxPromptChars)))
      .toThrow(PromptInputLimitError);
  });

  it("parses structured provider bodies and classifies their actionable errors", () => {
    const providerError = {
      statusCode: 400,
      message: "The model request failed",
      responseBody: JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message: "maximum context length exceeded",
        },
      }),
      responseHeaders: { "x-request-id": "request-123" },
    };

    expect(parseProviderError(providerError)).toEqual({
      status: 400,
      code: "context_length_exceeded",
      message: "maximum context length exceeded",
      requestId: "request-123",
    });
    expect(classifyGenerationError(providerError)).toMatchObject({
      code: "token_limit",
      retryable: false,
    });
    expect(
      classifyGenerationError(new PromptInputLimitError("combined input", 10, 11)),
    ).toMatchObject({ code: "token_limit", retryable: false });
  });

  it("does not promote arbitrary nested provider leaves into code or request id", () => {
    const providerError = {
      statusCode: 500,
      message: "provider secret details",
      responseBody: JSON.stringify({
        error: {
          metadata: {
            detail: "raw provider body should stay internal",
            value: "context_length_exceeded",
          },
          unrelated: "request-123",
        },
      }),
    };

    const parsed = parseProviderError(providerError);
    expect(parsed.status).toBe(500);
    expect(parsed.code).toBeUndefined();
    expect(parsed.requestId).toBeUndefined();
    expect(classifyGenerationError(providerError)).toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "The model provider is temporarily unavailable. Try again shortly.",
    });
  });

  it("accepts only constrained named code and request-id fields", () => {
    const safe = parseProviderError({
      statusCode: 503,
      responseBody: JSON.stringify({
        error: {
          code: "context_length_exceeded",
          requestId: "request-123",
        },
      }),
    });
    expect(safe).toMatchObject({
      status: 503,
      code: "context_length_exceeded",
      requestId: "request-123",
    });

    const malicious = parseProviderError({
      statusCode: 500,
      responseBody: JSON.stringify({
        error: {
          code: "provider code with secret details",
          requestId: "request id=secret",
        },
      }),
    });
    expect(malicious.code).toBeUndefined();
    expect(malicious.requestId).toBeUndefined();

    const oversized = parseProviderError({
      responseHeaders: { "x-request-id": "r".repeat(129) },
      responseBody: JSON.stringify({ error: { code: "c".repeat(129) } }),
    });
    expect(oversized.code).toBeUndefined();
    expect(oversized.requestId).toBeUndefined();
  });

  it("logs only allowlisted safe fields and never raw provider details", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("provider secret details");
    error.name = "password=secret";

    logRedactedError("provider secret details", error, {
      userId: "11111111-1111-1111-1111-111111111111",
      providerStatus: 500,
      providerCode: "sk_live_secret",
      requestId: "sk_live_secret",
      rawMessage: "provider response body secret",
      pathname: "users/secret/path",
    });

    expect(consoleError).toHaveBeenCalledWith("Application error", {
      userId: "11111111-1111-1111-1111-111111111111",
      providerStatus: 500,
      errorType: "Error",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("provider secret");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sk_live_secret");
  });

  it("preserves safe status, known provider code, and safe request id in logs", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    logRedactedError("Generation step failed", new Error("provider secret details"), {
      reviewerId: "22222222-2222-2222-2222-222222222222",
      providerStatus: 503,
      providerCode: "context_length_exceeded",
      requestId: "request-123",
      rawBody: "secret provider payload",
    });

    expect(consoleError).toHaveBeenCalledWith("Generation step failed", {
      reviewerId: "22222222-2222-2222-2222-222222222222",
      providerStatus: 503,
      providerCode: "context_length_exceeded",
      requestId: "request-123",
      errorType: "Error",
    });
  });

  it("recognizes provider payment bodies without exposing the raw payload", () => {
    const classified = classifyGenerationError({
      responseBody: JSON.stringify({
        error: { code: 402, message: "insufficient credits" },
      }),
    });
    expect(classified).toMatchObject({
      code: "payment_required",
      retryable: false,
    });
    expect(classified.message).not.toContain("insufficient credits");
  });

  it("does not expose an old persisted error_message through generation APIs", () => {
    expect(publicGenerationErrorMessage(null, "database password=secret")).toBe(
      "Generation failed unexpectedly. Try again shortly.",
    );
    expect(publicGenerationErrorMessage("unknown", "provider response body")).toBe(
      "Generation failed unexpectedly. Try again shortly.",
    );
    expect(publicGenerationErrorMessage("stale", "old raw message")).toMatch(
      /Study content changed/,
    );
    const serialized = serializeGenerationJob({
      id: "job-1",
      reviewerId: "reviewer-1",
      userId: "user-1",
      status: "failed",
      step: "summary",
      mode: "single",
      intent: "redo",
      targetKinds: ["summary"],
      completedKinds: [],
      upstreamRevisions: {},
      generationRunId: "run-1",
      active: false,
      claimToken: null,
      claimExpiresAt: null,
      claimedAt: null,
      errorCode: null,
      errorMessage: "database password=secret",
      modelUsed: null,
      forceOverwrite: false,
      expectedProtected: null,
      createdAt: new Date("2026-08-30T00:00:00Z"),
      updatedAt: new Date("2026-08-30T00:00:00Z"),
      finishedAt: null,
    });
    expect(serialized.errorMessage).toBe(
      "Generation failed unexpectedly. Try again shortly.",
    );
  });

  it("allows only safe Markdown URL protocols", () => {
    expect(sanitizeMarkdownUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(sanitizeMarkdownUrl("mailto:hello@example.com")).toBe(
      "mailto:hello@example.com",
    );
    expect(sanitizeMarkdownUrl("/topics/example")).toBe("/topics/example");
    expect(isSafeMarkdownUrl("javascript:alert(1)")).toBe(false);
    expect(sanitizeMarkdownUrl("data:text/html,<script>alert(1)</script>")).toBe(
      null,
    );
  });

  it("uses stdin for invite passwords and does not read a password argument", () => {
    const script = readFileSync(path.join(root, "scripts/create-user.ts"), "utf8");
    expect(script).toContain("readPassword");
    expect(script).not.toContain("const password = positional[1]");
    expect(script).toContain("process.argv.slice(2)");
  });
});
