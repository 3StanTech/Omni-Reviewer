import "server-only";

import { getEnv } from "@/lib/env";

/**
 * The shared OpenRouter key's free-model daily limit (its tier). Its `used`
 * and `remaining` stayed at 0 through dozens of requests on 2026-10-16, so the
 * app keeps its own count (lib/free-request-ledger.ts) and reads only the limit.
 * Reading it is not a model call; one cached read serves every account.
 */
export type FreeRequestQuota = { limit: number };

const KEY_URL = "https://openrouter.ai/api/v1/key";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 5_000;

let cached: { quota: FreeRequestQuota; at: number } | null = null;

function parseQuota(body: unknown): FreeRequestQuota | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const daily = (data as { free_model_daily_requests?: unknown }).free_model_daily_requests;
  if (!daily || typeof daily !== "object") return null;
  const { limit } = daily as Record<string, unknown>;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? { limit } : null;
}

/**
 * The daily free-request limit for the shared key, or null when unknown. Never throws.
 * `fresh` skips the cached read but still refreshes the cache.
 */
export async function readFreeRequestQuota(
  options: { fresh?: boolean } = {},
): Promise<FreeRequestQuota | null> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.quota;
  try {
    const response = await fetch(KEY_URL, {
      headers: { Authorization: `Bearer ${getEnv().OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const quota = parseQuota(await response.json());
    if (quota) cached = { quota, at: Date.now() };
    return quota;
  } catch {
    return null;
  }
}

/** Test hook: forget the cached quota. */
export function resetFreeRequestQuotaCache(): void {
  cached = null;
}
