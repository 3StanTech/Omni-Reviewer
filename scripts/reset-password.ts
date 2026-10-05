/**
 * Owner-run password reset (there is no email reset).
 *
 * Usage:
 *   printf '%s\n' '<password>' | npx tsx scripts/reset-password.ts <email>
 *   npx tsx scripts/reset-password.ts <email>   (on a TTY: hidden prompt)
 *
 * Sets the user's password, then mirrors the web reset success path: clears the
 * sign-in and reset throttles for that email and deletes its unused reset tokens.
 * Needs DATABASE_URL. Never prints the password or its hash.
 */

import { fileURLToPath } from "node:url";

import { neon } from "@neondatabase/serverless";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";

import { hashPassword } from "../lib/auth-utils";
import { normalizeLoginEmail } from "../lib/login-throttle";
import { passwordValidationError, resetThrottleKey } from "../lib/password-reset";
import { loginThrottles, passwordResetTokens, users } from "../lib/schema";
import { readPassword } from "./read-password";

export const RESET_PASSWORD_USAGE =
  "Usage: printf '%s\\n' '<password>' | npx tsx scripts/reset-password.ts <email>";

/** Exactly one positional argument (the email), normalized; null means show usage. */
export function parseResetPasswordArgs(argv: string[]): { email: string } | null {
  const positional = argv.filter((a) => a.trim().length > 0);
  if (positional.length !== 1) return null;
  const email = normalizeLoginEmail(positional[0]);
  return email.length > 0 ? { email } : null;
}

async function main() {
  const parsed = parseResetPasswordArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(RESET_PASSWORD_USAGE);
    process.exit(1);
  }
  const { email } = parsed;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Password is required on stdin");
    process.exit(1);
  }

  const passwordError = passwordValidationError(password);
  if (passwordError) {
    console.error(passwordError);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const db = drizzle(neon(databaseUrl), {
    schema: { users, loginThrottles, passwordResetTokens },
  });

  const [user] = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.email, email))
    .returning({ id: users.id });
  if (!user) {
    console.error(`No user: ${email}`);
    process.exit(1);
  }

  await db.delete(loginThrottles).where(eq(loginThrottles.email, email));
  await db
    .delete(loginThrottles)
    .where(eq(loginThrottles.email, resetThrottleKey(email)));
  await db
    .delete(passwordResetTokens)
    .where(
      and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.consumedAt)),
    );

  console.log(`Password reset for ${email}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
