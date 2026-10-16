import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const modelFactory = vi.hoisted(() => vi.fn());
const routerFactory = vi.hoisted(() => vi.fn(() => modelFactory));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: routerFactory,
}));

import { chainForPrompt, getOpenRouterModel, VERIFIED_FALLBACK_CATALOGUE } from "@/lib/openrouter";
import { DEFAULT_FALLBACKS, DEFAULT_MODEL, DEFAULT_VISION } from "@/lib/env";

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

  it("sends only verified free fallbacks and deny collection", () => {
    getOpenRouterModel("primary/model:free", { healJson: true });

    expect(modelFactory).toHaveBeenCalledWith(
      "primary/model:free",
      expect.objectContaining({
        extraBody: {
          models: ["google/gemma-4-31b-it:free"],
          provider: { data_collection: "deny" },
          reasoning: { enabled: false },
          plugins: [{ id: "response-healing" }],
        },
      }),
    );
    const options = modelFactory.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.models).toBeUndefined();
    expect(options.provider).toBeUndefined();
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

  it("routes an 18-page lecture to dots and three lectures past it", () => {
    const fallbacks = DEFAULT_FALLBACKS.split(",").map((id) => id.trim());
    for (const primary of [DEFAULT_MODEL, DEFAULT_VISION]) {
      expect(VERIFIED_FALLBACK_CATALOGUE.map((entry) => entry.id)).toContain(primary);
    }
    // PHA LEC LE2 05 is about 17K estimated prompt tokens; three lectures about 45K.
    expect(chainForPrompt(DEFAULT_MODEL, 17_000, { fallbacks }).model).toBe(DEFAULT_MODEL);
    const long = chainForPrompt(DEFAULT_MODEL, 45_000, { fallbacks, outputTokens: 16_000 });
    expect(long.model).toBe("google/gemma-4-31b-it:free");
    expect(long.fallbacks).toEqual([]);
    expect(DEFAULT_FALLBACKS).not.toContain("cohere/");
  });
});
