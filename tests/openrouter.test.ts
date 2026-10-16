import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const modelFactory = vi.hoisted(() => vi.fn());
const routerFactory = vi.hoisted(() => vi.fn(() => modelFactory));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: routerFactory,
}));

import { chainForPrompt, getOpenRouterModel, VERIFIED_FALLBACK_CATALOGUE } from "@/lib/openrouter";
import { DEFAULT_ASK, DEFAULT_FALLBACKS, DEFAULT_MODEL, DEFAULT_VISION } from "@/lib/env";

describe("OpenRouter request policy", () => {
  beforeEach(() => {
    modelFactory.mockReset();
    routerFactory.mockClear();
    process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdefgh";
    process.env.DATABASE_URL = "postgresql://user:password@example.test/db";
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
    process.env.OPENROUTER_API_KEY = "test-key-not-real";
    process.env.AUTH_URL = "http://localhost:3000";
    process.env.AI_MODEL_FALLBACKS = "google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free,openrouter/free";
  });

  it("sends only verified free fallbacks and no data-collection preference", () => {
    getOpenRouterModel("primary/model:free", { healJson: true });

    expect(modelFactory).toHaveBeenCalledWith(
      "primary/model:free",
      expect.objectContaining({
        extraBody: {
          models: ["google/gemma-4-31b-it:free"],
          reasoning: { enabled: false },
          plugins: [{ id: "response-healing" }],
        },
      }),
    );
    const options = modelFactory.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.models).toBeUndefined();
    expect(options.provider).toBeUndefined();
    const routerCalls = routerFactory.mock.calls as unknown as Array<[{ extraBody: Record<string, unknown> }]>;
    expect(routerCalls[0]?.[0].extraBody).not.toHaveProperty("provider");
  });

  it("drops fallback IDs outside the verified catalogue from dispatch", () => {
    getOpenRouterModel("primary/model:free", {
      fallbacks: [
        "unknown/model:free",
        "qwen/qwen3.8-27b:free",
        "openrouter/free",
      ],
    });

    const options = modelFactory.mock.calls[0]?.[1] as { extraBody: { models: string[] } };
    expect(options.extraBody.models).toEqual([]);
  });

  it("sends a chain with no fallbacks left as an empty list", () => {
    getOpenRouterModel("primary/model:free", { fallbacks: [] });

    const options = modelFactory.mock.calls[0]?.[1] as { extraBody: { models: string[] } };
    expect(options.extraBody.models).toEqual([]);
  });

  it("routes an 18-page lecture to dots, two lectures past it to Super VL and five to Gemma", () => {
    const fallbacks = DEFAULT_FALLBACKS.split(",").map((id) => id.trim());
    for (const primary of [DEFAULT_MODEL, DEFAULT_ASK, DEFAULT_VISION]) {
      expect(VERIFIED_FALLBACK_CATALOGUE.map((entry) => entry.id)).toContain(primary);
    }
    // PHA LEC LE2 05 is about 17K estimated prompt tokens; PHA plus MIC 3 about
    // 28K; five lectures about 44K, which no measured ceiling but Gemma's takes.
    expect(chainForPrompt(DEFAULT_MODEL, 17_000, { fallbacks }).model).toBe(DEFAULT_MODEL);
    const two = chainForPrompt(DEFAULT_MODEL, 33_000, { fallbacks, outputTokens: 16_000 });
    expect(two.model).toBe(DEFAULT_ASK);
    expect(two.fallbacks).toEqual(["google/gemma-4-31b-it:free"]);
    const five = chainForPrompt(DEFAULT_MODEL, 45_000, { fallbacks, outputTokens: 16_000 });
    expect(five.model).toBe("google/gemma-4-31b-it:free");
    expect(DEFAULT_FALLBACKS).not.toContain("cohere/");
  });

  it("puts Ask on Super VL first, with dots as its fallback while the prompt fits dots", () => {
    const fallbacks = DEFAULT_FALLBACKS.split(",").map((id) => id.trim());
    const ask = chainForPrompt(DEFAULT_ASK, 17_000, { fallbacks, outputTokens: 1_200 });
    expect(ask.model).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(ask.fallbacks).toEqual([DEFAULT_MODEL, "google/gemma-4-31b-it:free"]);
  });

  it("keeps vision requests on models that accept images", () => {
    const textOnly = "nvidia/nemotron-3-super-120b-a12b:free";
    const chain = chainForPrompt(textOnly, 2_000, { images: true, fallbacks: [DEFAULT_VISION] });
    expect(chain.model).toBe(DEFAULT_VISION);
    expect(() => chainForPrompt(textOnly, 2_000, { images: true, fallbacks: [] }))
      .toThrow("This source is too long for today's free models.");
    expect(VERIFIED_FALLBACK_CATALOGUE.every((entry) => typeof entry.supportsImages === "boolean")).toBe(true);
  });
});
