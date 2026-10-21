import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOGIN_THROTTLE_LOCK_MS,
  LOGIN_THROTTLE_WINDOW_MS,
  type LoginThrottleState,
  isLoginLocked,
  nextFailureState,
  normalizeLoginEmail,
} from "@/lib/login-throttle";

// In-memory stand-in for the login_throttles table, using the same pure rules.
const throttle = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  failReads: false,
  failWrites: false,
}));
const userRows = vi.hoisted(() => ({ value: [] as unknown[] }));

// next-auth's Next.js glue does not load under Vitest; authorize is tested directly.
vi.mock("next-auth", async () => {
  const { CredentialsSignin } = await import("@auth/core/errors");
  return { default: () => ({}), CredentialsSignin };
});
vi.mock("next-auth/providers/credentials", () => ({ default: () => ({}) }));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => userRows.value }) }),
    }),
  },
}));

vi.mock("@/lib/auth-utils", () => ({
  verifyPassword: async (password: string, hash: string) =>
    hash === `hash:${password}`,
}));

vi.mock("@/lib/queries", async () => {
  const rules = await import("@/lib/login-throttle");
  return {
    isLoginEmailLocked: vi.fn(async (email: string) => {
      if (throttle.failReads) throw new Error("db down");
      const row = throttle.rows.get(rules.normalizeLoginEmail(email)) as
        | LoginThrottleState
        | undefined;
      return row ? rules.isLoginLocked(row, new Date()) : false;
    }),
    recordLoginFailure: vi.fn(async (email: string) => {
      if (throttle.failWrites) throw new Error("db down");
      const key = rules.normalizeLoginEmail(email);
      const next = rules.nextFailureState(
        (throttle.rows.get(key) as LoginThrottleState | undefined) ?? null,
        new Date(),
      );
      throttle.rows.set(key, next);
      return { locked: rules.isLoginLocked(next, new Date()) };
    }),
    clearLoginThrottle: vi.fn(async (email: string) => {
      if (throttle.failWrites) throw new Error("db down");
      throttle.rows.delete(rules.normalizeLoginEmail(email));
    }),
  };
});

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

describe("credentials authorize throttle", () => {
  const user = {
    id: "user-1",
    email: "yana@example.com",
    name: "Yana",
    passwordHash: "hash:right-password",
  };

  async function codeOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return "signed_in";
  }

  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(48));
    vi.stubEnv("DATABASE_URL", "postgres://test");
    throttle.rows.clear();
    throttle.failReads = false;
    throttle.failWrites = false;
    userRows.value = [user];
  });

  it("locks a direct callback post on the fifth wrong password and refuses the right one", async () => {
    const { authorizeCredentials } = await import("@/auth");
    const queries = await import("@/lib/queries");
    for (let i = 0; i < 4; i += 1) {
      expect(
        await codeOf(
          authorizeCredentials({ email: user.email, password: "wrong" }),
        ),
      ).toBe("invalid_credentials");
    }
    expect(
      await codeOf(
        authorizeCredentials({ email: " YANA@example.com ", password: "wrong" }),
      ),
    ).toBe("login_locked");
    expect(queries.recordLoginFailure).toHaveBeenCalledTimes(5);

    expect(
      await codeOf(
        authorizeCredentials({ email: user.email, password: "right-password" }),
      ),
    ).toBe("login_locked");
    // Locked attempts are refused before any new failure is recorded.
    expect(queries.recordLoginFailure).toHaveBeenCalledTimes(5);
  });

  it("counts unknown accounts the same way", async () => {
    const { authorizeCredentials } = await import("@/auth");
    userRows.value = [];
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push(
        await codeOf(
          authorizeCredentials({ email: "nobody@example.com", password: "x" }),
        ),
      );
    }
    expect(codes).toEqual([
      "invalid_credentials",
      "invalid_credentials",
      "invalid_credentials",
      "invalid_credentials",
      "login_locked",
    ]);
  });

  it("clears earlier failures on a successful sign-in", async () => {
    const { authorizeCredentials } = await import("@/auth");
    for (let i = 0; i < 3; i += 1) {
      await codeOf(authorizeCredentials({ email: user.email, password: "wrong" }));
    }
    await expect(
      authorizeCredentials({ email: "Yana@Example.com", password: "right-password" }),
    ).resolves.toEqual({ id: user.id, email: user.email, name: user.name });
    expect(throttle.rows.has(user.email)).toBe(false);
  });

  it("fails closed when the throttle cannot be read or written", async () => {
    const { authorizeCredentials } = await import("@/auth");
    throttle.failReads = true;
    expect(
      await codeOf(
        authorizeCredentials({ email: user.email, password: "right-password" }),
      ),
    ).toBe("server_misconfigured");

    throttle.failReads = false;
    throttle.failWrites = true;
    expect(
      await codeOf(authorizeCredentials({ email: user.email, password: "wrong" })),
    ).toBe("server_misconfigured");
  });
});
