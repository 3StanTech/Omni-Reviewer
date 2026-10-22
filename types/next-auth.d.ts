import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email?: string | null;
      name?: string | null;
    } & DefaultSession["user"];
  }

  interface User {
    id: string;
    email?: string | null;
    name?: string | null;
    sessionVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    email?: string | null;
    name?: string | null;
    /** Absent on tokens issued before session versions existed; read as 0. */
    sessionVersion?: number;
  }
}

export {};
