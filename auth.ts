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
      async authorize(credentials) {
        const authSecret = process.env.AUTH_SECRET;
        const databaseUrl = process.env.DATABASE_URL;

        if (!isUsableAuthSecret(authSecret) || !databaseUrl) {
          throw new ServerMisconfigured();
        }

        const emailRaw =
          typeof credentials?.email === "string" ? credentials.email : "";
        const password =
          typeof credentials?.password === "string"
            ? credentials.password
            : "";
        const email = emailRaw.trim().toLowerCase();

        if (!email || !password) {
          throw new InvalidCredentials();
        }

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (!user || !(await verifyPassword(password, user.passwordHash))) {
          throw new InvalidCredentials();
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      },
    }),
  ],
});
