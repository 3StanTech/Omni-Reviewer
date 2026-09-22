import { describe, expect, it } from "vitest";

import {
  assertGenerationBudget,
  eligibleFreeModels,
  estimateTokensFromText,
  generationBudget,
  GenerationBudgetError,
} from "@/lib/ai-budgets";

describe("generation budgets", () => {
  it("uses source-proportional bands and finite item targets", () => {
    expect(generationBudget("test_me", 1_000)).toMatchObject({
      band: "short",
      maxItems: 5,
      attempts: 2,
    });
    expect(generationBudget("carded", 12_000)).toMatchObject({
      band: "long",
      maxItems: 30,
    });
  });

  it("rejects a request that cannot fit with output and safety margin", () => {
    const budget = generationBudget("summary", 5_000, {
      contextWindowTokens: 6_000,
      safetyMarginTokens: 1_000,
    });
    expect(() => assertGenerationBudget("x".repeat(20_000), budget)).toThrow(
      GenerationBudgetError,
    );
  });

  it("filters unknown, paid, privacy-incompatible, and undersized fallbacks", () => {
    const budget = generationBudget("summary", 1_000);
    expect(
      eligibleFreeModels(
        [
          {
            id: "good/model:free",
            contextLength: 32_768,
            maxOutputTokens: 8_000,
            pricing: { prompt: 0, completion: 0 },
            privacyCompatible: true,
          },
          {
            id: "paid/model",
            contextLength: 128_000,
            maxOutputTokens: 16_000,
            pricing: { prompt: 0, completion: 0 },
            privacyCompatible: true,
          },
          {
            id: "unknown/model:free",
            pricing: { prompt: 0, completion: 0 },
            privacyCompatible: true,
          },
        ],
        budget,
      ).map((model) => model.id),
    ).toEqual(["good/model:free"]);
  });

  it("uses the conservative four-character token estimate", () => {
    expect(estimateTokensFromText("12345")).toBe(2);
  });
});

