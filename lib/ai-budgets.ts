import {
  MAX_GENERATION_JSON_OUTPUT_TOKENS,
  MAX_GENERATION_TEXT_OUTPUT_TOKENS,
  MAX_GENERATION_PROMPT_TOKENS,
  MAX_GROUNDING_VERIFY_OUTPUT_TOKENS,
} from "@/lib/learning-limits";
import { parseCitations } from "@/lib/citations";

export type BudgetPurpose = "locked_in" | "summary" | "test_me" | "carded" | "json" | "vision" | "verify" | "ask";

/** Output target for one Ask answer: about 250 words plus citations, with room to spare. */
export const ASK_OUTPUT_TOKENS = 1_200;

export type SourceLengthBand = "short" | "medium" | "long";

export type GenerationBudget = {
  purpose: BudgetPurpose;
  sourceTokens: number;
  band: SourceLengthBand;
  maxOutputTokens: number;
  maxItems?: number;
  attempts: number;
  deadlineMs: number;
  contextWindowTokens: number;
  safetyMarginTokens: number;
};

export type ProviderModelDescriptor = {
  id: string;
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  pricing?: {
    prompt?: number | string | null;
    completion?: number | string | null;
  } | null;
  privacyCompatible?: boolean;
};

export type GenerationBudgetLimits = {
  contextWindowTokens: number;
  safetyMarginTokens: number;
  attempts: number;
  deadlineMs: number;
  /** Item target for Test Me or Carded; scales the output budget with it. */
  maxItems: number;
};

/** Conservative lower-bound assumptions until a live catalogue is reviewed. */
export const DEFAULT_BUDGET_LIMITS = {
  contextWindowTokens: 32_768,
  safetyMarginTokens: 1_024,
  attempts: 2,
  deadlineMs: 270_000,
} as const;

export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function classifySourceLength(sourceTokens: number): SourceLengthBand {
  if (sourceTokens <= 2_000) return "short";
  if (sourceTokens <= 10_000) return "medium";
  return "long";
}

function outputTarget(purpose: BudgetPurpose, band: SourceLengthBand): number {
  const textTargets = { short: 4_000, medium: 8_000, long: 16_000 } as const;
  const summaryTargets = { short: 3_000, medium: 6_000, long: 10_000 } as const;
  const testTargets = { short: 3_500, medium: 7_000, long: 12_000 } as const;
  const cardTargets = { short: 4_000, medium: 8_000, long: 14_000 } as const;

  switch (purpose) {
    case "locked_in":
      return textTargets[band];
    case "summary":
      return summaryTargets[band];
    case "test_me":
    case "json":
      return testTargets[band];
    case "carded":
      return cardTargets[band];
    case "vision":
      return 12_000;
    case "verify":
      return MAX_GROUNDING_VERIFY_OUTPUT_TOKENS;
    case "ask":
      return ASK_OUTPUT_TOKENS;
  }
}

function itemTarget(purpose: BudgetPurpose, band: SourceLengthBand): number | undefined {
  if (purpose === "test_me") return ({ short: 5, medium: 10, long: 20 } as const)[band];
  if (purpose === "carded") return ({ short: 10, medium: 20, long: 30 } as const)[band];
  return undefined;
}

/** Output tokens reserved per Test Me question or Carded card when items are page-scaled. */
const TOKENS_PER_ITEM = { test_me: 350, carded: 200 } as const;

/** Pages counted from one cited range, so a malformed huge range cannot inflate the target. */
const MAX_PAGES_PER_CITED_RANGE = 50;

/** Distinct (source, page) pairs cited in the Markdown. Whole-source citations such as [S2] are ignored. */
export function citedPageCount(markdown: string): number {
  const pages = new Set<string>();
  for (const citation of parseCitations(markdown)) {
    if (citation.pageStart === null || !Number.isFinite(citation.pageStart)) continue;
    const end = Math.min(
      citation.pageEnd ?? citation.pageStart,
      citation.pageStart + MAX_PAGES_PER_CITED_RANGE - 1,
    );
    for (let page = citation.pageStart; page <= end; page++) {
      pages.add(`${citation.source}:${page}`);
    }
  }
  return pages.size;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * About one Test Me question and two Carded cards per cited page. Material
 * without page citations falls back to the source-length bands.
 */
export function studyItemTarget(kind: "test_me" | "carded", markdown: string): number {
  const pages = citedPageCount(markdown);
  if (pages > 0) {
    return kind === "test_me" ? clamp(pages, 5, 30) : clamp(pages * 2, 10, 60);
  }
  return itemTarget(kind, classifySourceLength(estimateTokensFromText(markdown)))!;
}

export function generationBudget(
  purpose: BudgetPurpose,
  sourceTokens: number,
  limits: Partial<GenerationBudgetLimits> = {},
): GenerationBudget {
  if (!Number.isSafeInteger(sourceTokens) || sourceTokens < 1) {
    throw new Error("sourceTokens must be a positive safe integer");
  }
  const merged = { ...DEFAULT_BUDGET_LIMITS, ...limits };
  const band = classifySourceLength(sourceTokens);
  const hardMax = purpose === "vision"
    ? MAX_GENERATION_TEXT_OUTPUT_TOKENS
    : purpose === "locked_in" || purpose === "summary"
      ? MAX_GENERATION_TEXT_OUTPUT_TOKENS
      : MAX_GENERATION_JSON_OUTPUT_TOKENS;
  const bandTarget = outputTarget(purpose, band);
  const scaled = (purpose === "test_me" || purpose === "carded") && limits.maxItems !== undefined
    ? { items: limits.maxItems, tokens: limits.maxItems * TOKENS_PER_ITEM[purpose] }
    : undefined;
  const maxOutputTokens = Math.min(hardMax, scaled ? Math.max(bandTarget, scaled.tokens) : bandTarget);
  return {
    purpose,
    sourceTokens,
    band,
    maxOutputTokens,
    maxItems: scaled?.items ?? itemTarget(purpose, band),
    attempts: merged.attempts,
    deadlineMs: merged.deadlineMs,
    contextWindowTokens: merged.contextWindowTokens,
    safetyMarginTokens: merged.safetyMarginTokens,
  };
}

export class GenerationBudgetError extends Error {
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly contextWindowTokens: number;

  constructor(promptTokens: number, outputTokens: number, contextWindowTokens: number) {
    super(
      `The source material needs approximately ${promptTokens.toLocaleString()} input tokens plus ${outputTokens.toLocaleString()} output tokens, which exceeds the safe ${contextWindowTokens.toLocaleString()}-token provider budget. Split sources or shorten the material.`,
    );
    this.name = "GenerationBudgetError";
    this.promptTokens = promptTokens;
    this.outputTokens = outputTokens;
    this.contextWindowTokens = contextWindowTokens;
  }
}

export function assertGenerationBudget(
  prompt: string,
  budget: GenerationBudget,
): void {
  const promptTokens = estimateTokensFromText(prompt);
  const required = promptTokens + budget.maxOutputTokens + budget.safetyMarginTokens;
  if (required > budget.contextWindowTokens) {
    throw new GenerationBudgetError(
      promptTokens,
      budget.maxOutputTokens,
      budget.contextWindowTokens,
    );
  }
  if (promptTokens > MAX_GENERATION_PROMPT_TOKENS) {
    throw new GenerationBudgetError(
      promptTokens,
      budget.maxOutputTokens,
      MAX_GENERATION_PROMPT_TOKENS,
    );
  }
}

function parsePrice(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Filter a catalogue conservatively. Unknown context or pricing is excluded
 * until a human reviews it; this prevents an unknown fallback from silently
 * violating the free/privacy/request-size contract.
 */
export function eligibleFreeModels(
  descriptors: readonly ProviderModelDescriptor[],
  budget: GenerationBudget,
): ProviderModelDescriptor[] {
  return descriptors.filter((descriptor) => {
    const context = descriptor.contextLength;
    const completion = descriptor.pricing?.completion;
    const prompt = descriptor.pricing?.prompt;
    const promptPrice = parsePrice(prompt);
    const completionPrice = parsePrice(completion);
    return (
      descriptor.id.endsWith(":free") &&
      descriptor.privacyCompatible === true &&
      typeof context === "number" &&
      context >= budget.sourceTokens + budget.maxOutputTokens + budget.safetyMarginTokens &&
      typeof descriptor.maxOutputTokens === "number" &&
      descriptor.maxOutputTokens >= budget.maxOutputTokens &&
      promptPrice === 0 &&
      completionPrice === 0
    );
  });
}
