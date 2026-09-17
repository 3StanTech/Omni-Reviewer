import { describe, expect, it } from "vitest";

import {
  LOGIN_THROTTLE_LOCK_MS,
  LOGIN_THROTTLE_WINDOW_MS,
  isLoginLocked,
  nextFailureState,
  normalizeLoginEmail,
} from "@/lib/login-throttle";

const now = new Date("2026-09-17T12:00:00.000Z");

describe("login throttle", () => {
  it("normalizes trim and case", () => {
    expect(normalizeLoginEmail("  Admin@Example.COM ")).toBe("admin@example.com");
  });

  it("records the first failure in a new window", () => {
    const next = nextFailureState(null, now);
    expect(next.failedCount).toBe(1);
    expect(next.windowStartedAt).toEqual(now);
    expect(next.lockedUntil).toBeNull();
    expect(isLoginLocked(next, now)).toBe(false);
  });

  it("increments inside the window", () => {
    const first = nextFailureState(null, now);
    const inside = new Date(now.getTime() + 60_000);
    const second = nextFailureState(first, inside);
    expect(second.failedCount).toBe(2);
    expect(second.windowStartedAt).toEqual(now);
    expect(second.lockedUntil).toBeNull();
  });

  it("resets after the window", () => {
    const first = nextFailureState(null, now);
    const later = new Date(now.getTime() + LOGIN_THROTTLE_WINDOW_MS);
    const reset = nextFailureState(first, later);
    expect(reset.failedCount).toBe(1);
    expect(reset.windowStartedAt).toEqual(later);
    expect(reset.lockedUntil).toBeNull();
  });

  it("locks on the fifth failure", () => {
    let state = nextFailureState(null, now);
    for (let i = 0; i < 3; i += 1) {
      state = nextFailureState(state, now);
    }
    expect(state.failedCount).toBe(4);
    expect(state.lockedUntil).toBeNull();
    const locked = nextFailureState(state, now);
    expect(locked.failedCount).toBe(5);
    expect(locked.lockedUntil?.getTime()).toBe(now.getTime() + LOGIN_THROTTLE_LOCK_MS);
    expect(isLoginLocked(locked, now)).toBe(true);
  });

  it("stays locked until the lock expires", () => {
    const lockedUntil = new Date(now.getTime() + LOGIN_THROTTLE_LOCK_MS);
    const row = {
      failedCount: 5,
      windowStartedAt: now,
      lockedUntil,
    };
    const during = new Date(now.getTime() + 60_000);
    const still = nextFailureState(row, during);
    expect(still.failedCount).toBe(5);
    expect(still.lockedUntil).toEqual(lockedUntil);
    expect(isLoginLocked(still, during)).toBe(true);
  });

  it("uses the same failure path for any email key", () => {
    const unknown = nextFailureState(null, now);
    const known = nextFailureState(null, now);
    expect(unknown).toEqual(known);
  });
});
