import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { CredentialsSignin } from "next-auth";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

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
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  secret: nextAuthSecret,
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
