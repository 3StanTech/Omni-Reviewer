import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isMailConfigured, mailFromAddress } from "@/lib/mail";
import {
  createResetToken,
  hashResetToken,
  isResetExpired,
  passwordValidationError,
  resetTokensEqual,
  resetThrottleKey,
} from "@/lib/password-reset";

describe("password reset helpers", () => {
  it("hashes tokens and compares them in constant-length buffers", () => {
    const token = createResetToken();
    expect(token.length).toBeGreaterThan(20);
    const hashed = hashResetToken(token);
    expect(hashed).toHaveLength(64);
    expect(hashed).toBe(hashResetToken(token));
    expect(hashed).not.toBe(hashResetToken(`${token}x`));
    expect(resetTokensEqual(hashed, hashed)).toBe(true);
    expect(resetTokensEqual(hashed, hashResetToken("other"))).toBe(false);
  });

  it("treats expiry as closed at the deadline", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    expect(isResetExpired(new Date("2026-09-17T11:00:00.000Z"), now)).toBe(true);
    expect(isResetExpired(now, now)).toBe(true);
    expect(isResetExpired(new Date("2026-09-17T13:00:00.000Z"), now)).toBe(false);
  });

  it("rejects short, long, and empty passwords", () => {
    expect(passwordValidationError("short")).toMatch(/at least 10/);
    expect(passwordValidationError("x".repeat(257))).toMatch(/too long/);
    expect(passwordValidationError("long-enough-password")).toBeNull();
  });

  it("keeps reset throttles off the login lock key", () => {
    expect(resetThrottleKey("you@example.com")).toBe("reset:you@example.com");
  });
});

describe("mail configuration", () => {
  it("defaults the from address and treats a missing API key as unconfigured", () => {
    const previous = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    expect(isMailConfigured()).toBe(false);
    expect(mailFromAddress({ EMAIL_FROM: undefined })).toBe(
      "Omni-Reviewer <beth.t@example.com>",
    );
    expect(mailFromAddress({ EMAIL_FROM: "Desk <notes@example.com>" })).toBe(
      "Desk <notes@example.com>",
    );
    if (previous === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous;
  });
});
