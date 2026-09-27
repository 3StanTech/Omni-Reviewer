import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const modelFactory = vi.hoisted(() => vi.fn());
const routerFactory = vi.hoisted(() => vi.fn(() => modelFactory));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: routerFactory,
}));

import { contextWindowForRequest, getOpenRouterModel, selectVerifiedFallbackModels, VERIFIED_FALLBACK_CATALOGUE } from "@/lib/openrouter";
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
    process.env.AI_MODEL_FALLBACKS = "qwen/qwen3.8-27b:free,nvidia/nemotron-3-super-120b-a12b:free,openrouter/free";
  });

  it("sends only verified free fallbacks and deny collection", () => {
    getOpenRouterModel("primary/model:free", { healJson: true });

    expect(modelFactory).toHaveBeenCalledWith(
      "primary/model:free",
      expect.objectContaining({
        extraBody: {
          models: ["qwen/qwen3.8-27b:free"],
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

  it("rejects unknown and context-incompatible fallback IDs from dispatch", () => {
    getOpenRouterModel("primary/model:free", {
      fallbacks: [
        "unknown/model:free",
        "google/gemma-4-31b-it:free",
        "openrouter/free",
      ],
    });

    const options = modelFactory.mock.calls[0]?.[1] as { extraBody: { models: string[] } };
    expect(options.extraBody.models).toEqual([]);
  });

  it("keeps a non-empty verified fallback list for every default primary", () => {
    const configured = DEFAULT_FALLBACKS.split(",").map((id) => id.trim());
    for (const primary of [DEFAULT_MODEL, DEFAULT_VISION]) {
      const usable = selectVerifiedFallbackModels(configured).filter((id) => id !== primary);
      expect(usable.length).toBeGreaterThan(0);
    }
    expect(VERIFIED_FALLBACK_CATALOGUE.map((entry) => entry.id)).toContain(DEFAULT_MODEL);
  });

  it("sizes the request budget from the verified catalogue, not a fixed 32K window", () => {
    const configured = DEFAULT_FALLBACKS.split(",").map((id) => id.trim());
    const fallbacks = selectVerifiedFallbackModels(configured);
    // An 18-page lecture needs about 17K input plus 16K output tokens.
    expect(contextWindowForRequest(DEFAULT_MODEL, fallbacks)).toBeGreaterThanOrEqual(200_000);
    expect(contextWindowForRequest("unknown/model:free", [])).toBe(32_768);
    expect(contextWindowForRequest(DEFAULT_MODEL, ["unknown/model:free"])).toBe(32_768);
  });
});
