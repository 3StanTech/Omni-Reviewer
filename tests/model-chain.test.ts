import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { chainForPrompt, orderedChain, TOKENIZER_HEADROOM } from "@/lib/openrouter";
import { GenerationError } from "@/lib/generation-errors";

const DOTS = "dots-studio/dots-3-note-preview:free";
const GEMMA = "google/gemma-4-31b-it:free";
const DOTS_MAX = 30_000;
const GEMMA_MAX = 200_000;

/** Largest estimate whose head-roomed size still fits a ceiling. */
const largestFitting = (ceiling: number) => Math.floor(ceiling / TOKENIZER_HEADROOM);

describe("chainForPrompt", () => {
  const fallbacks = [DOTS, GEMMA];

  it("keeps the whole chain, in order, when every model fits", () => {
    const chain = chainForPrompt(DOTS, 1_000, { fallbacks });
    expect(chain).toEqual({ model: DOTS, fallbacks: [GEMMA], contextWindowTokens: 262_144 });
  });

  it("keeps dots exactly at its ceiling and skips it one token over", () => {
    expect(chainForPrompt(DOTS, largestFitting(DOTS_MAX), { fallbacks }).model).toBe(DOTS);
    const over = chainForPrompt(DOTS, largestFitting(DOTS_MAX) + 1, { fallbacks });
    expect(over.model).toBe(GEMMA);
    expect(over.fallbacks).toEqual([]);
  });

  it("budgets with the chosen models' window only", () => {
    expect(chainForPrompt(DOTS, 40_000, { fallbacks }).contextWindowTokens).toBe(262_144);
    expect(chainForPrompt(DOTS, 1_000, { fallbacks: [DOTS] }).contextWindowTokens).toBe(512_000);
  });

  it("skips a model whose output cap is below the request", () => {
    expect(chainForPrompt(DOTS, 40_000, { fallbacks, outputTokens: 32_768 }).model).toBe(GEMMA);
    expect(() => chainForPrompt(DOTS, 40_000, { fallbacks, outputTokens: 32_769 })).toThrow(GenerationError);
  });

  it("refuses, not retryable, when nothing fits", () => {
    let error: unknown;
    try {
      chainForPrompt(DOTS, largestFitting(GEMMA_MAX) + 1, { fallbacks });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).code).toBe("token_limit");
    expect((error as GenerationError).retryable).toBe(false);
  });

  it("gives an unknown primary the conservative 32K ceiling and window", () => {
    const small = chainForPrompt("someone/new-model:free", 1_000, { fallbacks });
    expect(small.model).toBe("someone/new-model:free");
    expect(small.contextWindowTokens).toBe(32_768);
    expect(chainForPrompt("someone/new-model:free", 40_000, { fallbacks }).model).toBe(GEMMA);
  });

  it("deduplicates the primary and drops uncatalogued fallbacks", () => {
    expect(orderedChain(DOTS, [DOTS, "qwen/qwen3.8-27b:free", GEMMA, "openrouter/free"])).toEqual([DOTS, GEMMA]);
  });
});
