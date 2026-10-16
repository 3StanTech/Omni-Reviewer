import "server-only";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { type ProviderModelDescriptor } from "@/lib/ai-budgets";
import { getEnv } from "@/lib/env";
import { GenerationError } from "@/lib/generation-errors";
import { CONSERVATIVE_GENERATION_CONTEXT_TOKENS } from "@/lib/learning-limits";

const OPENROUTER_FREE_MODEL = /^[^/\s]+\/[^/\s]+:free$/;

/**
 * Study output needs the whole output budget for the answer. Free reasoning
 * models otherwise spend it thinking and return empty text (seen 2026-09-27).
 */
const STUDY_REASONING = { enabled: false } as const;

/**
 * Static catalogue of the free models the chain may use. Input ceilings
 * (`maxInputTokens`) are measured by live probes, never taken from the
 * listing; `countsTowardFreeLimit` is whether a request moved `/api/v1/key`
 * free_model_daily_requests; `supportsImages` is the listing's input
 * modalities. Probed on 2026-10-16, with free endpoints that may train on
 * request data allowed.
 */
export const VERIFIED_FALLBACK_CATALOGUE: readonly ProviderModelDescriptor[] = [
  {
    id: "dots-studio/dots-3-note-preview:free",
    contextLength: 512_000,
    maxOutputTokens: 460_800,
    // Answered cleanly at 30K real tokens; at 47K it answered but mis-tagged
    // the answer, and on the night of Oct 15 it returned 400 above about 15K.
    maxInputTokens: 30_000,
    countsTowardFreeLimit: false,
    supportsImages: true,
    pricing: { prompt: 0, completion: 0 },
    privacyCompatible: true,
  },
  {
    id: "nvidia/nemotron-3.5-super-vl:free",
    contextLength: 1_000_000,
    maxOutputTokens: 131_072,
    // Ask answered correctly and cited at 18K, 30K and 48K real tokens in 2-38 s.
    // A five-lecture Locked In ran past 16K output tokens, so it stays off the
    // Locked In head.
    maxInputTokens: 48_000,
    countsTowardFreeLimit: false,
    supportsImages: true,
    pricing: { prompt: 0, completion: 0 },
    privacyCompatible: true,
  },
  {
    id: "google/gemma-4-31b-it:free",
    contextLength: 262_144,
    maxOutputTokens: 32_768,
    // Listing value less the output cap: the shared Google pool answered 429
    // to every probe on 2026-10-16, so the ceiling and gating are unmeasured.
    maxInputTokens: 200_000,
    countsTowardFreeLimit: false,
    supportsImages: true,
    pricing: { prompt: 0, completion: 0 },
    privacyCompatible: true,
  },
];

/** Head room over the chars/4 estimate; real tokens ran about 6% higher. */
export const TOKENIZER_HEADROOM = 1.1;

export type ModelChain = {
  model: string;
  fallbacks: string[];
  /** Smallest context window among the chosen models. */
  contextWindowTokens: number;
};

export function catalogueEntry(modelId: string): ProviderModelDescriptor | undefined {
  return VERIFIED_FALLBACK_CATALOGUE.find((entry) => entry.id === modelId);
}

/** Configured fallbacks limited to catalogued free models allowed under the data policy. */
export function selectVerifiedFallbackModels(
  modelIds: readonly string[],
): string[] {
  return modelIds.filter((modelId) => {
    const entry = catalogueEntry(modelId);
    return entry !== undefined && entry.id.endsWith(":free") && entry.privacyCompatible === true;
  });
}

/** The primary, then the verified fallbacks, deduplicated in order. */
export function orderedChain(
  primary: string,
  fallbacks: readonly string[] = parseFallbackModels(),
): string[] {
  return [...new Set([assertPrimaryModelId(primary), ...selectVerifiedFallbackModels(fallbacks)])];
}

/**
 * The models that can take this prompt: every chain entry whose measured
 * input ceiling fits the estimate plus head room and whose output cap fits the
 * request. A model outside the catalogue gets the conservative window.
 * With `images`, only catalogued models that accept image input stay.
 */
export function chainForPrompt(
  primary: string,
  promptTokens: number,
  options: { outputTokens?: number; fallbacks?: readonly string[]; images?: boolean } = {},
): ModelChain {
  const needed = Math.ceil(promptTokens * TOKENIZER_HEADROOM);
  const outputTokens = options.outputTokens ?? 0;
  const fits = orderedChain(primary, options.fallbacks).filter((modelId) => {
    const entry = catalogueEntry(modelId);
    if (options.images && entry?.supportsImages !== true) return false;
    const maxInput = entry?.maxInputTokens ?? CONSERVATIVE_GENERATION_CONTEXT_TOKENS;
    const maxOutput = entry?.maxOutputTokens ?? Number.POSITIVE_INFINITY;
    return maxInput >= needed && maxOutput >= outputTokens;
  });
  if (fits.length === 0) {
    throw new GenerationError("token_limit", "This source is too long for today's free models.", false);
  }
  return {
    model: fits[0]!,
    fallbacks: fits.slice(1),
    contextWindowTokens: Math.min(
      ...fits.map((modelId) => catalogueEntry(modelId)?.contextLength ?? CONSERVATIVE_GENERATION_CONTEXT_TOKENS),
    ),
  };
}

export function isPinnedFreeModelId(modelId: string): boolean {
  const normalized = modelId.trim();
  return (
    OPENROUTER_FREE_MODEL.test(normalized) &&
    !normalized.startsWith("openrouter/auto")
  );
}

export function isAllowedFallbackModelId(modelId: string): boolean {
  const normalized = modelId.trim();
  return normalized === "openrouter/free" || isPinnedFreeModelId(normalized);
}

export function assertPrimaryModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (!isPinnedFreeModelId(normalized)) {
    throw new Error(
      `Invalid primary OpenRouter model id "${normalized}". Use a pinned :free model id; openrouter/auto and paid models are not allowed.`,
    );
  }
  return normalized;
}

export function assertFallbackModelIds(modelIds: string[]): string[] {
  const normalized = modelIds.map((modelId) => modelId.trim()).filter(Boolean);
  if (
    normalized.length === 0 ||
    normalized.some((modelId) => !isAllowedFallbackModelId(modelId))
  ) {
    throw new Error(
      "Invalid OpenRouter fallback model list. Use pinned :free model ids and openrouter/free only; openrouter/auto and paid models are not allowed.",
    );
  }
  return normalized;
}

export function parseFallbackModels(raw?: string): string[] {
  const configured = raw ?? getEnv().AI_MODEL_FALLBACKS;
  return assertFallbackModelIds(
    configured.split(",")
      .map((s) => s.trim()),
  );
}

export function getOpenRouter() {
  const env = getEnv();
  const fallbacks = selectVerifiedFallbackModels(
    parseFallbackModels(env.AI_MODEL_FALLBACKS),
  );
  const appUrl = env.AUTH_URL ?? "https://omni-reviewer.app";

  return createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
    headers: {
      "HTTP-Referer": appUrl,
      "X-Title": "Omni-Reviewer",
    },
    appName: "Omni-Reviewer",
    appUrl,
    extraBody: {
      models: fallbacks,
      reasoning: STUDY_REASONING,
    },
  });
}

export type OpenRouterModelOptions = {
  /** Enable response-healing for JSON / generateObject calls. */
  healJson?: boolean;
  /** Fallbacks for this request, normally a chainForPrompt result; defaults to AI_MODEL_FALLBACKS. */
  fallbacks?: string[];
};

/** Build a chat model with fallbacks and optional response healing. */
export function getOpenRouterModel(
  modelId: string,
  options: OpenRouterModelOptions = {},
) {
  const primary = assertPrimaryModelId(modelId);
  const openrouter = getOpenRouter();
  // A chosen chain may legitimately have no fallbacks left.
  const configuredFallbacks = options.fallbacks === undefined
    ? parseFallbackModels()
    : options.fallbacks.length === 0 ? [] : assertFallbackModelIds(options.fallbacks);
  const fallbacks = selectVerifiedFallbackModels(configuredFallbacks)
    .filter((id) => id !== primary);

  return openrouter(primary, {
    extraBody: {
      models: fallbacks,
      reasoning: STUDY_REASONING,
      ...(options.healJson
        ? { plugins: [{ id: "response-healing" }] }
        : {}),
    },
  });
}
