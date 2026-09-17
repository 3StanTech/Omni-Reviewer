import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("proxy AUTH_SECRET fail-closed contract", () => {
  it("validates before Auth.js initialization and preserves public route branches", () => {
    const source = readFileSync(path.resolve(__dirname, "../proxy.ts"), "utf8");
    expect(source).toContain("isUsableAuthSecret(configuredSecret)");
    expect(source).toContain("const nextAuthSecret =");
    expect(source).toContain("secret: nextAuthSecret");
    expect(source).toContain("if (!isUsableAuthSecret(process.env.AUTH_SECRET))");
    expect(source).toContain('pathname === "/api/auth"');
    expect(source).toContain('pathname === "/login"');
    expect(source).toContain('pathname === "/forgot-password"');
    expect(source).toContain('pathname === "/reset-password"');
    expect(source).toContain('status: 503');
  });
});
