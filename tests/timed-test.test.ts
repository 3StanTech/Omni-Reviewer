import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createTimedTestSession,
  verifyTimedTestSession,
} from "@/lib/test-timing";

describe("timed Test Me session claims", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-secret-for-timed-sessions-0123456789";
  });

  it("signs a server-issued deadline and verifies owner/revision claims", () => {
    const now = new Date("2026-08-31T00:00:00.000Z");
    const session = createTimedTestSession({
      userId: "user-1",
      reviewerId: "reviewer-1",
      viewRevision: 4,
      durationSeconds: 300,
      now,
    });
    expect(session.token).not.toContain("test-secret");
    expect(verifyTimedTestSession(session.token, new Date("2026-08-31T00:01:00.000Z"))).toMatchObject({
      ok: true,
      claims: { userId: "user-1", reviewerId: "reviewer-1", viewRevision: 4 },
    });
  });

  it("rejects tampering, early clocks, and expired deadlines", () => {
    const session = createTimedTestSession({
      userId: "user-1",
      reviewerId: "reviewer-1",
      viewRevision: 1,
      now: new Date("2026-08-31T00:00:00.000Z"),
    });
    const [payload, signature] = session.token.split(".");
    expect(verifyTimedTestSession(`${payload}x.${signature}`, new Date("2026-08-31T00:00:01.000Z"))).toEqual({ ok: false, reason: "invalid" });
    expect(verifyTimedTestSession(session.token, new Date("2026-08-30T23:59:59.000Z"))).toEqual({ ok: false, reason: "invalid" });
    expect(verifyTimedTestSession(session.token, new Date("2026-08-31T00:05:00.000Z"))).toEqual({ ok: false, reason: "expired" });
  });

  it("bounds session duration and token size", () => {
    expect(() => createTimedTestSession({ userId: "u", reviewerId: "r", viewRevision: 1, durationSeconds: 29 })).toThrow();
    expect(verifyTimedTestSession("x".repeat(4097))).toEqual({ ok: false, reason: "invalid" });
  });

  it("fails closed when the timed-session secret is too short", () => {
    process.env.AUTH_SECRET = "too-short";
    expect(() => createTimedTestSession({
      userId: "u",
      reviewerId: "r",
      viewRevision: 1,
    })).toThrow(/32 bytes/i);
  });
});
