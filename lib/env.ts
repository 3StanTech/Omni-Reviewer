import "server-only";

import { z } from "zod";

import { AUTH_SECRET_ERROR, isUsableAuthSecret } from "@/lib/auth-secret";
import { logRedactedError } from "@/lib/public-errors";

const DEFAULT_MODEL = "z-ai/glm-5.2:free";
const DEFAULT_VISION = "minimax/minimax-m3:free";
const DEFAULT_FALLBACKS =
  "nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,openrouter/free";

const nonEmpty = z.string().trim().min(1);
const authSecret = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().refine(isUsableAuthSecret, AUTH_SECRET_ERROR),
);
const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalUrl = z.preprocess(
  blankAsUndefined,
  z.string().url().optional(),
);
const modelId = nonEmpty.refine(
  (value) =>
    /^[^/\s]+\/[^/\s]+:free$/.test(value) &&
    !value.startsWith("openrouter/auto"),
  "must be a pinned free OpenRouter model id (ending in :free)",
);
const fallbackModelList = nonEmpty.refine(
  (value) => {
    const models = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return (
      models.length > 0 &&
      models.every(
        (item) =>
          item === "openrouter/free" ||
          (/^[^/\s]+\/[^/\s]+:free$/.test(item) &&
            !item.startsWith("openrouter/auto")),
      )
    );
  },
  "must contain only pinned free OpenRouter model ids or openrouter/free",
);
const configuredModel = z.preprocess(blankAsUndefined, modelId.default(DEFAULT_MODEL));
const configuredVisionModel = z.preprocess(
  blankAsUndefined,
  modelId.default(DEFAULT_VISION),
);
const configuredFallbacks = z.preprocess(
  blankAsUndefined,
  fallbackModelList.default(DEFAULT_FALLBACKS),
);

/**
 * Server environment contract. Keep this schema in one place so route handlers,
 * scripts, and future workers fail with the same actionable configuration
 * error. The legacy AI_MODEL/Gemini/shared-password variables are intentionally
 * not part of the contract.
 */
export const envSchema = z.object({
  AUTH_SECRET: authSecret,
  AUTH_TRUST_HOST: z.preprocess(
    blankAsUndefined,
    z.enum(["true", "false"]).default("true"),
  ),
  AUTH_URL: optionalUrl,
  DATABASE_URL: nonEmpty,
  BLOB_READ_WRITE_TOKEN: nonEmpty,
  OPENROUTER_API_KEY: nonEmpty,
  RESEND_API_KEY: z.preprocess(blankAsUndefined, z.string().trim().min(1).optional()),
  EMAIL_FROM: z.preprocess(blankAsUndefined, z.string().trim().min(3).optional()),
  AI_MODEL_LOCKED_IN: configuredModel,
  AI_MODEL_SUMMARY: configuredModel,
  AI_MODEL_JSON: configuredModel,
  AI_MODEL_VISION: configuredVisionModel,
  AI_MODEL_FALLBACKS: configuredFallbacks,
});

export type Env = z.infer<typeof envSchema>;

function isBuildPhase(): boolean {
  return (
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.NEXT_PHASE === "phase-export"
  );
}

let cached: Env | null = null;

/**
 * Validate and return the complete runtime environment.
 *
 * Build-time code should use getBuildEnv instead. Runtime request paths must
 * never inherit the build/CI exception, because a CI flag is not proof that a
 * deployed function has valid secrets.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const result = envSchema.safeParse(process.env);

  if (result.success) {
    cached = result.data;
    return cached;
  }

  logRedactedError("Invalid runtime environment", result.error, {
    invalidKeys: result.error.issues.map((issue) => issue.path.join("."))
      .join(","),
  });
  throw new Error("Invalid environment variables");
}

/**
 * Return defaults suitable for static/build analysis without pretending that
 * the resulting values are valid runtime configuration. This is intentionally
 * separate from getEnv so request paths cannot accidentally bypass validation.
 */
export function getBuildEnv(): Partial<Env> {
  if (!isBuildPhase()) {
    throw new Error("getBuildEnv is only available during a Next.js build phase");
  }

  const result = envSchema.safeParse(process.env);
  if (result.success) return result.data;

  return {
    AUTH_SECRET: process.env.AUTH_SECRET?.trim() ?? "",
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST === "false" ? "false" : "true",
    AUTH_URL:
      process.env.AUTH_URL && process.env.AUTH_URL.trim().length > 0
        ? process.env.AUTH_URL.trim()
        : undefined,
    DATABASE_URL: process.env.DATABASE_URL?.trim() ?? "",
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "",
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY?.trim() ?? "",
    RESEND_API_KEY: process.env.RESEND_API_KEY?.trim() || undefined,
    EMAIL_FROM: process.env.EMAIL_FROM?.trim() || undefined,
    AI_MODEL_LOCKED_IN: process.env.AI_MODEL_LOCKED_IN?.trim() || DEFAULT_MODEL,
    AI_MODEL_SUMMARY: process.env.AI_MODEL_SUMMARY?.trim() || DEFAULT_MODEL,
    AI_MODEL_JSON: process.env.AI_MODEL_JSON?.trim() || DEFAULT_MODEL,
    AI_MODEL_VISION: process.env.AI_MODEL_VISION?.trim() || DEFAULT_VISION,
    AI_MODEL_FALLBACKS: process.env.AI_MODEL_FALLBACKS?.trim() || DEFAULT_FALLBACKS,
  };
}
