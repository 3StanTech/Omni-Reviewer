import { z } from "zod";

const DEFAULT_MODEL = "z-ai/glm-5.2:free";
const DEFAULT_VISION = "minimax/minimax-m3:free";
const DEFAULT_FALLBACKS =
  "nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,openrouter/free";

const envSchema = z.object({
  AUTH_SECRET: z.string().min(1),
  AUTH_TRUST_HOST: z.string().optional(),
  AUTH_URL: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  BLOB_READ_WRITE_TOKEN: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1),
  AI_MODEL: z.string().optional(),
  AI_MODEL_LOCKED_IN: z.string().default(DEFAULT_MODEL),
  AI_MODEL_SUMMARY: z.string().default(DEFAULT_MODEL),
  AI_MODEL_JSON: z.string().default(DEFAULT_MODEL),
  AI_MODEL_VISION: z.string().default(DEFAULT_VISION),
  AI_MODEL_FALLBACKS: z.string().default(DEFAULT_FALLBACKS),
});

export type Env = z.infer<typeof envSchema>;

function isBuildPhase(): boolean {
  return (
    process.env.CI === "true" ||
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.NEXT_PHASE === "phase-export"
  );
}

let cached: Env | null = null;

/**
 * Validate and return runtime env. Safe during `next build` when secrets
 * are absent (returns a partial best-effort object only if building).
 * Production request paths should call this and expect validation.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const result = envSchema.safeParse({
    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST,
    AUTH_URL: process.env.AUTH_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    AI_MODEL_LOCKED_IN: process.env.AI_MODEL_LOCKED_IN ?? DEFAULT_MODEL,
    AI_MODEL_SUMMARY: process.env.AI_MODEL_SUMMARY ?? DEFAULT_MODEL,
    AI_MODEL_JSON: process.env.AI_MODEL_JSON ?? DEFAULT_MODEL,
    AI_MODEL_VISION: process.env.AI_MODEL_VISION ?? DEFAULT_VISION,
    AI_MODEL_FALLBACKS: process.env.AI_MODEL_FALLBACKS ?? DEFAULT_FALLBACKS,
  });

  if (result.success) {
    cached = result.data;
    return cached;
  }

  if (isBuildPhase()) {
    // Do not throw during build/CI when runtime secrets are not present.
    return {
      AUTH_SECRET: process.env.AUTH_SECRET ?? "",
      AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST,
      AUTH_URL: process.env.AUTH_URL,
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN ?? "",
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
      AI_MODEL: process.env.AI_MODEL,
      AI_MODEL_LOCKED_IN: process.env.AI_MODEL_LOCKED_IN ?? DEFAULT_MODEL,
      AI_MODEL_SUMMARY: process.env.AI_MODEL_SUMMARY ?? DEFAULT_MODEL,
      AI_MODEL_JSON: process.env.AI_MODEL_JSON ?? DEFAULT_MODEL,
      AI_MODEL_VISION: process.env.AI_MODEL_VISION ?? DEFAULT_VISION,
      AI_MODEL_FALLBACKS: process.env.AI_MODEL_FALLBACKS ?? DEFAULT_FALLBACKS,
    };
  }

  throw new Error(
    `Invalid environment variables: ${result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`,
  );
}
