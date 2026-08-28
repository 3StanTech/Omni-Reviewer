import "server-only";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const DEFAULT_FALLBACKS =
  "nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,openrouter/free";

export function parseFallbackModels(raw?: string): string[] {
  return (raw ?? process.env.AI_MODEL_FALLBACKS ?? DEFAULT_FALLBACKS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getOpenRouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const fallbacks = parseFallbackModels();

  return createOpenRouter({
    apiKey,
    headers: {
      "HTTP-Referer": process.env.AUTH_URL ?? "https://omni-reviewer.app",
      "X-Title": "Omni-Reviewer",
    },
    appName: "Omni-Reviewer",
    appUrl: process.env.AUTH_URL ?? "https://omni-reviewer.app",
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
  const openrouter = getOpenRouter();
  const fallbacks = (options.fallbacks ?? parseFallbackModels()).filter(
    (id) => id !== modelId,
  );

  return openrouter(modelId, {
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
