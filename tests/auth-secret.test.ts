import { describe, expect, it } from "vitest";

import {
  AUTH_SECRET_ERROR,
  isUsableAuthSecret,
  requireAuthSecret,
} from "@/lib/auth-secret";

describe("shared AUTH_SECRET contract", () => {
  it("accepts only secrets with both minimum character and byte lengths", () => {
    expect(isUsableAuthSecret("x".repeat(31))).toBe(false);
    expect(isUsableAuthSecret("x".repeat(32))).toBe(true);
    expect(isUsableAuthSecret(" ".repeat(32))).toBe(false);
    expect(isUsableAuthSecret("é".repeat(32))).toBe(true);
    expect(isUsableAuthSecret(null)).toBe(false);
  });

  it("trims usable secrets and never includes the secret in the failure", () => {
    const value = "too-short-secret";
    expect(requireAuthSecret(`  ${"x".repeat(32)}  `)).toBe("x".repeat(32));
    expect(() => requireAuthSecret(value)).toThrow(AUTH_SECRET_ERROR);
    try {
      requireAuthSecret(value);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(value);
    }
  });
});
