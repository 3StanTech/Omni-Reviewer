import "server-only";

import { getEnv } from "@/lib/env";

/**
 * Free-model daily request quota for the shared OpenRouter key. Reading it is
 * not a model call. Every account shares one key, so one cached read serves all.
 */
export type FreeRequestQuota = { used: number; limit: number; remaining: number };

const KEY_URL = "https://openrouter.ai/api/v1/key";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 5_000;

let cached: { quota: FreeRequestQuota; at: number } | null = null;

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseQuota(body: unknown): FreeRequestQuota | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const daily = (data as { free_model_daily_requests?: unknown }).free_model_daily_requests;
  if (!daily || typeof daily !== "object") return null;
  const { used, limit, remaining } = daily as Record<string, unknown>;
  const quota = { used: count(used), limit: count(limit), remaining: count(remaining) };
  if (quota.used === null || quota.limit === null || quota.remaining === null) return null;
  return { used: quota.used, limit: quota.limit, remaining: quota.remaining };
}

/**
 * Today's free-model requests for the shared key, or null when unknown. Never throws.
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
