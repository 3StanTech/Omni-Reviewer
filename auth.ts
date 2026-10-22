import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { CredentialsSignin } from "next-auth";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { cache } from "react";

import { authConfig } from "./auth.config";
import { verifyPassword } from "./lib/auth-utils";
import { db } from "./lib/db";
import { users } from "./lib/schema";
import { isUsableAuthSecret } from "./lib/auth-secret";
import { normalizeLoginEmail } from "./lib/login-throttle";
import {
  clearLoginThrottle,
  isLoginEmailLocked,
  recordLoginFailure,
} from "./lib/queries";

const configuredSecret = process.env.AUTH_SECRET;
// Auth.js still needs a valid key to initialize during a build or a
// misconfigured runtime. Use a per-process throwaway key in that case; the
// authorize guard below prevents any session from being minted or trusted.
const nextAuthSecret = isUsableAuthSecret(configuredSecret)
  ? configuredSecret.trim()
  : randomBytes(32).toString("base64url");

class ServerMisconfigured extends CredentialsSignin {
  code = "server_misconfigured";
}

class InvalidCredentials extends CredentialsSignin {
  code = "invalid_credentials";
}

class LoginLocked extends CredentialsSignin {
  code = "login_locked";
}

/**
 * Credentials check for every sign-in path (login page and direct callback
 * posts), so all attempts count against one lockout. Throttle errors fail
 * closed: the password is never checked without the lock check.
 */
export async function authorizeCredentials(
  credentials: Partial<Record<string, unknown>> | undefined,
) {
  const authSecret = process.env.AUTH_SECRET;
  const databaseUrl = process.env.DATABASE_URL;

  if (!isUsableAuthSecret(authSecret) || !databaseUrl) {
    throw new ServerMisconfigured();
  }

  const emailRaw =
    typeof credentials?.email === "string" ? credentials.email : "";
  const password =
    typeof credentials?.password === "string" ? credentials.password : "";
  const email = normalizeLoginEmail(emailRaw);

  if (!email || !password) {
    throw new InvalidCredentials();
  }

  let locked: boolean;
  try {
    locked = await isLoginEmailLocked(email);
  } catch {
    throw new ServerMisconfigured();
  }
  if (locked) {
    throw new LoginLocked();
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    let recorded: { locked: boolean };
    try {
      recorded = await recordLoginFailure(email);
    } catch {
      throw new ServerMisconfigured();
    }
    throw recorded.locked ? new LoginLocked() : new InvalidCredentials();
  }

  try {
    await clearLoginThrottle(email);
  } catch {
    throw new ServerMisconfigured();
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    sessionVersion: user.sessionVersion,
  };
}

/**
 * The server authentication boundary for every `auth()` call (pages, routes,
 * server actions). A token whose session version is below the account's
 * current one was issued before a password reset and is refused, as is a
 * token whose account no longer exists. A token minted before session
 * versions existed counts as version 0, so it stays valid until the first
 * reset. A failed lookup throws, which Auth.js treats as no session.
 */
async function currentSessionToken(token: JWT): Promise<JWT | null> {
  if (typeof token.sub !== "string" || token.sub.length === 0) return null;
  const currentVersion = await accountSessionVersion(token.sub);
  if (currentVersion === null) return null;
  const tokenVersion =
    typeof token.sessionVersion === "number" ? token.sessionVersion : 0;
  return tokenVersion < currentVersion ? null : token;
}

/**
 * The account's current session version, or null when it no longer exists.
 * React `cache` dedupes the lookup only within one server render pass (a
 * rejected lookup is shared too, so it still fails closed). Route handlers,
 * server actions and code outside a render each query again.
 */
const accountSessionVersion = cache(
  async (userId: string): Promise<number | null> => {
    const [row] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ? row.sessionVersion : null;
  },
);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  secret: nextAuthSecret,
  callbacks: {
    ...authConfig.callbacks,
    // proxy.ts keeps the edge-safe callback (no database read per request);
    // the version check runs here, where pages and routes resolve the session.
    async jwt(params) {
      const token = authConfig.callbacks.jwt(params);
      if (params.user) {
        token.sessionVersion =
          typeof params.user.sessionVersion === "number"
            ? params.user.sessionVersion
            : 0;
        return token;
      }
      return currentSessionToken(token);
    },
  },
  providers: [
    Credentials({
      id: "credentials",
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: authorizeCredentials,
    }),
  ],
});

/**
 * Sends a signed-in visitor from a public auth page to "/". `auth()` applies
 * the session-version check, so a revoked cookie renders the page instead of
 * looping between "/" and the page (proxy.ts lets public auth pages through).
 */
export async function redirectIfSignedIn(): Promise<void> {
  const session = await auth();
  if (session?.user?.id) redirect("/");
}
