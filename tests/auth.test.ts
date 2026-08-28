import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  hashPassword,
  ownedOrNull,
  safeEqualPassword,
  verifyPassword,
} from "@/lib/auth-utils";

const root = path.resolve(__dirname, "..");

describe("auth", () => {
  it("timing-safe compare rejects a wrong password", () => {
    expect(safeEqualPassword("correct-horse", "correct-horse")).toBe(true);
    expect(safeEqualPassword("wrong-password", "correct-horse")).toBe(false);
    expect(safeEqualPassword("short", "correct-horse")).toBe(false);
    expect(safeEqualPassword("correct-horse!", "correct-horse")).toBe(false);
  });

  it("scrypt hash verifies and rejects wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("ownedOrNull returns null for mismatched userId", () => {
    const row = { id: "t1", userId: "user-a", name: "Chem" };
    expect(ownedOrNull(row, row.userId, "user-a")).toEqual(row);
    expect(ownedOrNull(row, row.userId, "user-b")).toBeNull();
    expect(ownedOrNull(null, "user-a", "user-a")).toBeNull();
    expect(ownedOrNull(row, null, "user-a")).toBeNull();
  });

  it("login Client Component does not read APP_PASSWORD or OPENROUTER_API_KEY", () => {
    const loginForm = readFileSync(
      path.join(root, "components/login-form.tsx"),
      "utf8",
    );
    expect(loginForm).toMatch(/["']use client["']/);
    expect(loginForm).not.toContain("APP_PASSWORD");
    expect(loginForm).not.toContain("OPENROUTER_API_KEY");
    expect(loginForm).not.toContain("process.env.APP_PASSWORD");
    expect(loginForm).not.toContain("process.env");
    expect(loginForm).toContain('name="email"');
    expect(loginForm).toContain('name="password"');
  });

  it("login page is a Server Component (secrets stay server-side)", () => {
    const loginPage = readFileSync(
      path.join(root, "app/login/page.tsx"),
      "utf8",
    );
    expect(loginPage).not.toMatch(/^["']use client["']/m);
    expect(loginPage).toContain("use server");
    expect(loginPage).not.toContain("APP_PASSWORD");
  });
});
