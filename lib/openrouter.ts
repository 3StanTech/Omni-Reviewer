import "server-only";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { eligibleFreeModels, type GenerationBudget, type ProviderModelDescriptor } from "@/lib/ai-budgets";
import { getEnv } from "@/lib/env";
import {
  GENERATION_CONTEXT_SAFETY_MARGIN_TOKENS,
  MAX_GENERATION_JSON_OUTPUT_TOKENS,
  MAX_GENERATION_PROMPT_TOKENS,
  MAX_GENERATION_ATTEMPTS,
  GENERATION_STEP_DEADLINE_MS,
} from "@/lib/learning-limits";

const OPENROUTER_FREE_MODEL = /^[^/\s]+\/[^/\s]+:free$/;

/**
 * Static, conservative catalogue snapshot from the 2026-09-20 read-only
 * assessment. Unknown or stale catalogue entries are deliberately excluded;
 * the configured primary remains untouched and can fail with its own budget.
 */
const VERIFIED_FALLBACK_CATALOGUE: readonly ProviderModelDescriptor[] = [
  {
    id: "qwen/qwen3.8-27b:free",
    contextLength: 262_144,
    maxOutputTokens: 235_929,
    pricing: { prompt: 0, completion: 0 },
    privacyCompatible: true,
  },
];

const CONSERVATIVE_FALLBACK_BUDGET: GenerationBudget = {
  purpose: "json",
  sourceTokens: MAX_GENERATION_PROMPT_TOKENS,
  band: "long",
  maxOutputTokens: MAX_GENERATION_JSON_OUTPUT_TOKENS,
  attempts: MAX_GENERATION_ATTEMPTS,
  deadlineMs: GENERATION_STEP_DEADLINE_MS,
  contextWindowTokens: 262_144,
  safetyMarginTokens: GENERATION_CONTEXT_SAFETY_MARGIN_TOKENS,
};

export function selectVerifiedFallbackModels(
  modelIds: readonly string[],
): string[] {
  const descriptors = eligibleFreeModels(
    VERIFIED_FALLBACK_CATALOGUE,
    CONSERVATIVE_FALLBACK_BUDGET,
  );
  const verified = new Set(descriptors.map((descriptor) => descriptor.id));
  return modelIds.filter((modelId) => verified.has(modelId));
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
      // OpenRouter API / SDK use snake_case for this preference.
      provider: { data_collection: "deny" },
    },
  });
}

export type OpenRouterModelOptions = {
  /** Enable response-healing for JSON / generateObject calls. */
  healJson?: boolean;
  /** Override fallback list; defaults to AI_MODEL_FALLBACKS. */
  fallbacks?: string[];
};

/** Build a chat model with fallbacks and optional response healing. */
export function getOpenRouterModel(
  modelId: string,
  options: OpenRouterModelOptions = {},
) {
  const primary = assertPrimaryModelId(modelId);
  const openrouter = getOpenRouter();
  const configuredFallbacks = assertFallbackModelIds(
    options.fallbacks ?? parseFallbackModels(),
  );
  const fallbacks = selectVerifiedFallbackModels(configuredFallbacks)
    .filter((id) => id !== primary);

  return openrouter(primary, {
    extraBody: {
      models: fallbacks,
      provider: { data_collection: "deny" },
      ...(options.healJson
        ? { plugins: [{ id: "response-healing" }] }
        : {}),
    },
  });
}
