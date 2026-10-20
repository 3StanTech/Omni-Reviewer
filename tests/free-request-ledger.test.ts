import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  countsTowardFreeLimit,
  freeRequestState,
  REQUESTS_PER_PACK,
  utcDay,
} from "@/lib/free-request-ledger";
import { packsLeftCopy } from "@/lib/generation-queue";
import { classifyGenerationError } from "@/lib/generation-errors";

describe("utcDay", () => {
  it("rolls over at 00:00 UTC, which is 8:00 AM Manila", () => {
    expect(utcDay(new Date("2026-10-16T23:59:59.999Z"))).toBe("2026-10-16");
    expect(utcDay(new Date("2026-10-17T00:00:00.000Z"))).toBe("2026-10-17");
    // 7:59 AM and 8:00 AM Manila on Oct 17.
    expect(utcDay(new Date("2026-10-17T07:59:00+08:00"))).toBe("2026-10-16");
    expect(utcDay(new Date("2026-10-17T08:00:00+08:00"))).toBe("2026-10-17");
  });
});

describe("freeRequestState", () => {
  const limited = (requestsLeft: number) =>
    freeRequestState({ limited: true, limit: 50, requests: 50 - requestsLeft, exhausted: false });

  it("floors packs left at about 12 requests per pack", () => {
    expect(REQUESTS_PER_PACK).toBe(12);
    expect(limited(11)).toMatchObject({ requestsLeft: 11, packsLeft: 0 });
    expect(limited(12)).toMatchObject({ requestsLeft: 12, packsLeft: 1 });
    expect(limited(23)).toMatchObject({ requestsLeft: 23, packsLeft: 1 });
    expect(limited(50)).toMatchObject({ requestsLeft: 50, packsLeft: 4 });
  });

  it("never goes below zero when the count passes the limit", () => {
    expect(freeRequestState({ limited: true, limit: 50, requests: 61, exhausted: false }))
      .toMatchObject({ requestsLeft: 0, packsLeft: 0, exhausted: false });
  });

  it("lets a real per-day 429 win over the count", () => {
    expect(freeRequestState({ limited: true, limit: 50, requests: 3, exhausted: true }))
      .toEqual({ limited: true, limit: 50, requestsLeft: 0, packsLeft: 0, exhausted: true });
    expect(freeRequestState({ limited: false, limit: 50, requests: null, exhausted: true }))
      .toMatchObject({ requestsLeft: 0, exhausted: true });
  });

  it("has no count when nothing is gated or the ledger cannot be read", () => {
    expect(freeRequestState({ limited: false, limit: 50, requests: 9, exhausted: false }))
      .toMatchObject({ requestsLeft: null, packsLeft: null });
    expect(freeRequestState({ limited: true, limit: 50, requests: null, exhausted: false }))
      .toMatchObject({ requestsLeft: null, packsLeft: null });
  });
});

describe("gated models", () => {
  it("counts only models flagged as gated", () => {
    const fixture = new Map([
      ["gated/model:free", { id: "gated/model:free", countsTowardFreeLimit: true }],
      ["open/model:free", { id: "open/model:free", countsTowardFreeLimit: false }],
      ["unflagged/model:free", { id: "unflagged/model:free" }],
    ]);
    const lookup = (id: string) => fixture.get(id);
    expect(countsTowardFreeLimit("gated/model:free", lookup)).toBe(true);
    expect(countsTowardFreeLimit("open/model:free", lookup)).toBe(false);
    expect(countsTowardFreeLimit("unflagged/model:free", lookup)).toBe(false);
    expect(countsTowardFreeLimit("unknown/model:free", lookup)).toBe(false);
  });
});

describe("packsLeftCopy", () => {
  const state = { limited: true, limit: 50, requestsLeft: 40, packsLeft: 3, exhausted: false };

  it("words each state", () => {
    expect(packsLeftCopy(state)).toEqual({ text: "About 3 packs left today · resets 8:00 AM", low: false });
    expect(packsLeftCopy({ ...state, requestsLeft: 12, packsLeft: 1 })?.text).toBe("About 1 pack left today · resets 8:00 AM");
    expect(packsLeftCopy({ ...state, requestsLeft: 5, packsLeft: 0 })).toEqual({ text: "Less than a pack left today · resets 8:00 AM", low: true });
    expect(packsLeftCopy({ ...state, exhausted: true })).toEqual({ text: "Today's free requests are used up. More at 8:00 AM.", low: true });
    expect(packsLeftCopy({ ...state, limited: false, requestsLeft: null, packsLeft: null })?.text).toBe("Requests available today · resets 8:00 AM");
    expect(packsLeftCopy({ ...state, requestsLeft: null, packsLeft: null })).toBeNull();
  });
});

describe("daily limit classification", () => {
  it("tells OpenRouter's per-day cap from a per-minute 429", () => {
    expect(classifyGenerationError({ statusCode: 429, message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day" }))
      .toMatchObject({ code: "daily_limit", retryable: false, message: "Today's free requests are used up. More at 8:00 AM." });
    expect(classifyGenerationError({ statusCode: 429, message: "Rate limit exceeded: free-models-per-min." }))
      .toMatchObject({ code: "rate_limited", retryable: true });
    expect(classifyGenerationError({ statusCode: 400, message: "limit per day" }).code).not.toBe("daily_limit");
  });
});
