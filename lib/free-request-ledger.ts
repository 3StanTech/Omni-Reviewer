import "server-only";

import { eq, sql } from "drizzle-orm";

import type { ProviderModelDescriptor } from "@/lib/ai-budgets";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { catalogueEntry, orderedChain, parseFallbackModels } from "@/lib/openrouter";
import { readFreeRequestQuota } from "@/lib/openrouter-quota";
import { logRedactedError } from "@/lib/public-errors";
import type { FreeRequestState } from "@/lib/generation-queue";
import { freeRequestDays } from "@/lib/schema";

/** About this many model requests make one pack (all four modes with checks). */
export const REQUESTS_PER_PACK = 12;
/** OpenRouter's free tier when `/key` cannot be read. */
export const DEFAULT_FREE_REQUEST_LIMIT = 50;

export type { FreeRequestState };

/** OpenRouter's free counter resets at 00:00 UTC (8:00 AM Manila). */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function countsTowardFreeLimit(
  modelId: string,
  lookup: (modelId: string) => ProviderModelDescriptor | undefined = catalogueEntry,
): boolean {
  return lookup(modelId)?.countsTowardFreeLimit === true;
}

/** Every model a request may reach today, across all purposes. */
function configuredChainModels(): string[] {
  const env = getEnv();
  const fallbacks = parseFallbackModels(env.AI_MODEL_FALLBACKS);
  const primaries = [env.AI_MODEL_LOCKED_IN, env.AI_MODEL_SUMMARY, env.AI_MODEL_JSON, env.AI_MODEL_ASK, env.AI_MODEL_VISION];
  return [...new Set(primaries.flatMap((primary) => orderedChain(primary, fallbacks)))];
}

export function freeRequestState(args: {
  limited: boolean;
  limit: number;
  /** Gated requests counted today, or null when the count cannot be read. */
  requests: number | null;
  exhausted: boolean;
}): FreeRequestState {
  if (args.exhausted) {
    return { limited: args.limited, limit: args.limit, requestsLeft: 0, packsLeft: 0, exhausted: true };
  }
  if (!args.limited || args.requests === null) {
    return { limited: args.limited, limit: args.limit, requestsLeft: null, packsLeft: null, exhausted: false };
  }
  const requestsLeft = Math.max(0, args.limit - args.requests);
  return {
    limited: true,
    limit: args.limit,
    requestsLeft,
    packsLeft: Math.floor(requestsLeft / REQUESTS_PER_PACK),
    exhausted: false,
  };
}

/**
 * Count one model attempt toward today's free requests when its model is
 * gated. A ledger failure is logged and never fails the request.
 */
export async function recordModelRequest(modelId: string, now: Date = new Date()): Promise<void> {
  if (!countsTowardFreeLimit(modelId)) return;
  try {
    await getDb()
      .insert(freeRequestDays)
      .values({ day: utcDay(now), requests: 1 })
      .onConflictDoUpdate({
        target: freeRequestDays.day,
        set: { requests: sql`${freeRequestDays.requests} + 1`, updatedAt: sql`now()` },
      });
  } catch (error) {
    logRedactedError("Free request ledger failed", error);
  }
}

/** OpenRouter refused with its per-day free limit: today is used up. */
export async function markDailyLimitReached(now: Date = new Date()): Promise<void> {
  try {
    await getDb()
      .insert(freeRequestDays)
      .values({ day: utcDay(now), exhaustedAt: now })
      .onConflictDoUpdate({
        target: freeRequestDays.day,
        set: {
          exhaustedAt: sql`coalesce(${freeRequestDays.exhaustedAt}, now())`,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    logRedactedError("Free request ledger failed", error);
  }
}

/** Today's packs left from the app's own count. Never throws; reading it calls no model. */
export async function readFreeRequestState(options: { fresh?: boolean } = {}): Promise<FreeRequestState> {
  const limited = configuredChainModels().some((modelId) => countsTowardFreeLimit(modelId));
  const limit = limited
    ? (await readFreeRequestQuota(options))?.limit ?? DEFAULT_FREE_REQUEST_LIMIT
    : DEFAULT_FREE_REQUEST_LIMIT;
  try {
    const [row] = await getDb()
      .select({ requests: freeRequestDays.requests, exhaustedAt: freeRequestDays.exhaustedAt })
      .from(freeRequestDays)
      .where(eq(freeRequestDays.day, utcDay()))
      .limit(1);
    return freeRequestState({
      limited,
      limit,
      requests: row?.requests ?? 0,
      exhausted: Boolean(row?.exhaustedAt),
    });
  } catch (error) {
    logRedactedError("Free request ledger failed", error);
    return freeRequestState({ limited, limit, requests: null, exhausted: false });
  }
}
