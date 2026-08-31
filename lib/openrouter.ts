import "server-only";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { getEnv } from "@/lib/env";

const OPENROUTER_FREE_MODEL = /^[^/\s]+\/[^/\s]+:free$/;

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
  const fallbacks = parseFallbackModels(env.AI_MODEL_FALLBACKS);
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
  const fallbacks = configuredFallbacks.filter((id) => id !== primary);

  return openrouter(primary, {
    models: fallbacks,
    provider: { data_collection: "deny" },
    ...(options.healJson
      ? { plugins: [{ id: "response-healing" as const }] }
      : {}),
    extraBody: {
      models: fallbacks,
      provider: { data_collection: "deny" },
      ...(options.healJson
        ? { plugins: [{ id: "response-healing" }] }
        : {}),
    },
  });
}
