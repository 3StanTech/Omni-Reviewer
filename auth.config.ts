import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe Auth.js config. No node:crypto / scrypt / db here —
 * middleware/proxy imports this file only. Credentials authorize lives in auth.ts.
 */
export const authConfig = {
  // Honor AUTH_TRUST_HOST so first production deploy works before AUTH_URL exists.
  trustHost: true,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  // Providers with Node-only authorize are added in auth.ts.
  providers: [],
  callbacks: {
    authorized() {
      // Custom gate logic lives in proxy.ts (redirect vs 401 JSON).
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.email =
          typeof token.email === "string" ? token.email : session.user.email;
        session.user.name =
          typeof token.name === "string" ? token.name : session.user.name;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
