import { describe, expect, it } from "vitest";

import { normalizeLoginEmail } from "@/lib/login-throttle";
import { parseResetPasswordArgs } from "../scripts/reset-password";

describe("parseResetPasswordArgs", () => {
  it("returns the normalized email for exactly one argument", () => {
    expect(parseResetPasswordArgs(["  Yana@Example.COM "])).toEqual({
      email: "yana@example.com",
    });
  });

  it("matches the login throttle normalization", () => {
    const raw = " Someone@Example.com\t";
    expect(parseResetPasswordArgs([raw])?.email).toBe(normalizeLoginEmail(raw));
  });

  it("rejects no arguments", () => {
    expect(parseResetPasswordArgs([])).toBeNull();
    expect(parseResetPasswordArgs(["", "   "])).toBeNull();
  });

  it("rejects extra arguments", () => {
    expect(parseResetPasswordArgs(["a@example.com", "b@example.com"])).toBeNull();
    expect(parseResetPasswordArgs(["a@example.com", "--force"])).toBeNull();
  });
});
