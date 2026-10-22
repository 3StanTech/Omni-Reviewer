import { readFileSync } from "node:fs";
import path from "node:path";

import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashPassword,
  ownedOrNull,
  safeEqualPassword,
  verifyPassword,
} from "@/lib/auth-utils";
import { LOGIN_THROTTLE_LOCKED_MESSAGE } from "@/lib/login-throttle";

const signIn = vi.hoisted(() => vi.fn());
const redirectIfSignedIn = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/auth", () => ({ redirectIfSignedIn, signIn }));
vi.mock("@/components/login-form", () => ({ LoginForm: () => null }));
vi.mock("next-auth", async () => {
  const errors = await import("@auth/core/errors");
  return { AuthError: errors.AuthError };
});

const root = path.resolve(__dirname, "..");

type LoginAction = (prev: string | null, formData: FormData) => Promise<string | null>;

function findAction(node: ReactNode): LoginAction | null {
  if (!isValidElement<{ action?: LoginAction; children?: ReactNode }>(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findAction(child);
        if (found) return found;
      }
    }
    return null;
  }
  if (node.props.action) return node.props.action;
  return findAction(node.props.children);
}

async function loadLoginAction(): Promise<LoginAction> {
  const { default: LoginPage } = await import("@/app/login/page");
  const action = findAction(await LoginPage());
  if (!action) throw new Error("login action not found");
  return action;
}

function loginForm(email: string, password: string) {
  const form = new FormData();
  form.set("email", email);
  form.set("password", password);
  return form;
}

async function signInError(code: string) {
  const { CredentialsSignin } = await import("@auth/core/errors");
  const error = new CredentialsSignin();
  error.code = code;
  return error;
}

describe("login page action", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(48));
    vi.stubEnv("DATABASE_URL", "postgres://test");
  });

  it("maps authorize codes to the login messages", async () => {
    const action = await loadLoginAction();
    const cases: [string, string][] = [
      ["login_locked", LOGIN_THROTTLE_LOCKED_MESSAGE],
      ["server_misconfigured", "Server is misconfigured. Try again later."],
      ["invalid_credentials", "Invalid email or password."],
    ];
    for (const [code, message] of cases) {
      signIn.mockRejectedValueOnce(await signInError(code));
      expect(await action(null, loginForm(" Yana@Example.com ", "pw"))).toBe(
        message,
      );
    }
    expect(signIn).toHaveBeenLastCalledWith("credentials", {
      email: "yana@example.com",
      password: "pw",
      redirectTo: "/",
    });
  });

  it("lets the success redirect propagate", async () => {
    const action = await loadLoginAction();
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/;307;",
    });
    signIn.mockRejectedValueOnce(redirect);
    await expect(action(null, loginForm("yana@example.com", "pw"))).rejects.toBe(
      redirect,
    );
  });
});

describe("login page with a session", () => {
  it("sends a signed-in visitor home and renders otherwise", async () => {
    const { default: LoginPage } = await import("@/app/login/page");
    const { redirect } = await import("next/navigation");
    redirectIfSignedIn.mockImplementationOnce(async () => redirect("/"));
    await expect(LoginPage()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    await expect(LoginPage()).resolves.toBeTruthy();
  });
});

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
    expect(loginForm).toContain("Forgot password?");
    expect(loginForm).toContain('href="/forgot-password"');
  });

  it("login page is a Server Component (secrets stay server-side)", () => {
    const loginPage = readFileSync(
      path.join(root, "app/login/page.tsx"),
      "utf8",
    );
    expect(loginPage).not.toMatch(/^["']use client["']/m);
    expect(loginPage).toContain("use server");
    expect(loginPage).not.toContain("APP_PASSWORD");
    expect(loginPage).toContain("LOGIN_THROTTLE_LOCKED_MESSAGE");
  });
});
