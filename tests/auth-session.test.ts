import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database boundary is substituted, and next-auth's thin Next.js wrapper is
// replaced by @auth/core directly (vitest loads next-auth outside the
// transform, where its "next/server" import cannot resolve). Auth.js core,
// CSRF, credentials authorize, scrypt hashing, session cookies and the app's
// own callbacks and proxy logic are real.
type StoredUser = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string;
  sessionVersion: number;
};
const state = vi.hoisted(() => ({
  user: null as StoredUser | null,
  failReads: false,
  reads: 0,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            state.reads++;
            if (state.failReads) throw new Error("database unavailable");
            return state.user ? [{ ...state.user }] : [];
          },
        }),
      }),
    }),
  },
}));
vi.mock("next-auth", async () => {
  const { Auth } = await import("@auth/core");
  const errors = await import("@auth/core/errors");
  type Config = Parameters<typeof Auth>[1];
  function NextAuth(input: Config) {
    const config = { ...input, basePath: "/api/auth" } as Config;
    const handle = (req: Request) => Auth(req, config);
    async function sessionFor(req: Request) {
      const response = await Auth(
        new Request(new URL("/api/auth/session", req.url), {
          headers: { cookie: req.headers.get("cookie") ?? "" },
        }),
        config,
      );
      return response.ok ? await response.json() : null;
    }
    // Middleware form used by proxy.ts: auth((req) => ...).
    const auth = (handler: (req: Request & { auth: unknown }) => unknown) =>
      async (req: Request) => {
        const session = await sessionFor(req);
        return handler(Object.assign(req, { auth: session }));
      };
    return { handlers: { GET: handle, POST: handle }, auth, signIn: vi.fn(), signOut: vi.fn() };
  }
  return { default: NextAuth, CredentialsSignin: errors.CredentialsSignin, AuthError: errors.AuthError };
});
vi.mock("@/lib/queries", () => ({
  isLoginEmailLocked: async () => false,
  recordLoginFailure: async () => ({ locked: false }),
  clearLoginThrottle: async () => undefined,
}));

const ORIGIN = "http://localhost:3217";
const BASE = `${ORIGIN}/api/auth`;
const SESSION_COOKIE = "authjs.session-token";
const PASSWORD = "synthetic-password-0001";

let handlers: typeof import("@/auth").handlers;

class Jar {
  private cookies = new Map<string, string>();
  absorb(response: Response) {
    for (const item of response.headers.getSetCookie()) {
      const pair = item.split(";")[0]!;
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  has(name: string) {
    return this.cookies.has(name);
  }
}

async function signInJar(): Promise<Jar> {
  const jar = new Jar();
  const csrf = await handlers.GET(new NextRequest(`${BASE}/csrf`));
  jar.absorb(csrf);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const response = await handlers.POST(
    new NextRequest(`${BASE}/callback/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: jar.header(),
      },
      body: new URLSearchParams({
        email: state.user!.email,
        password: PASSWORD,
        csrfToken,
        callbackUrl: `${ORIGIN}/`,
      }),
    }),
  );
  expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
  jar.absorb(response);
  expect(jar.has(SESSION_COOKIE)).toBe(true);
  return jar;
}

async function readSession(cookie: string) {
  const response = await handlers.GET(
    new NextRequest(`${BASE}/session`, { headers: { cookie } }),
  );
  const clearsCookie = response.headers
    .getSetCookie()
    .some((c) => c.startsWith(`${SESSION_COOKIE}=;`));
  return {
    session: (await response.json()) as { user?: { id: string } } | null,
    clearsCookie,
  };
}

/** A cookie minted the way Auth.js did before session versions existed. */
async function preVersionCookie(): Promise<string> {
  const { encode } = await import("@auth/core/jwt");
  const token = await encode({
    token: { sub: state.user!.id, email: state.user!.email, name: state.user!.name },
    secret: process.env.AUTH_SECRET!,
    salt: SESSION_COOKIE,
  });
  return `${SESSION_COOKIE}=${token}`;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "auth-session-test-secret-0000000000000000";
  process.env.DATABASE_URL = "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic";
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;
  ({ handlers } = await import("@/auth"));
});

beforeEach(async () => {
  const { hashPassword } = await import("@/lib/auth-utils");
  state.failReads = false;
  state.reads = 0;
  state.user = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "session@example.invalid",
    name: "Synthetic",
    passwordHash: await hashPassword(PASSWORD),
    sessionVersion: 0,
  };
});

describe("session version at the server boundary", () => {
  it("refuses an old session after a reset and accepts a new login", async () => {
    const before = await signInJar();
    const first = await readSession(before.header());
    expect(first.session?.user?.id).toBe(state.user!.id);

    // Either reset path raises the stored version.
    state.user!.sessionVersion = 1;
    const revoked = await readSession(before.header());
    expect(revoked.session).toBeNull();
    expect(revoked.clearsCookie).toBe(true);

    const after = await signInJar();
    const fresh = await readSession(after.header());
    expect(fresh.session?.user?.id).toBe(state.user!.id);

    // A second reset revokes the post-reset login too.
    state.user!.sessionVersion = 2;
    expect((await readSession(after.header())).session).toBeNull();
  });

  it("keeps a session issued before session versions until the first reset", async () => {
    const cookie = await preVersionCookie();
    expect((await readSession(cookie)).session?.user?.id).toBe(state.user!.id);
    state.user!.sessionVersion = 1;
    expect((await readSession(cookie)).session).toBeNull();
  });

  it("refuses a session whose account no longer exists", async () => {
    const jar = await signInJar();
    state.user = null;
    expect((await readSession(jar.header())).session).toBeNull();
  });

  it("fails closed when the version lookup fails", async () => {
    const jar = await signInJar();
    state.failReads = true;
    expect((await readSession(jar.header())).session).toBeNull();
  });
});

describe("proxy with a revoked cookie", () => {
  it("lets public auth pages render instead of bouncing to the home page", async () => {
    const jar = await signInJar();
    state.user!.sessionVersion = 1;
    const { default: proxy } = await import("@/proxy");
    const run = proxy as unknown as (req: NextRequest, ctx: unknown) => Promise<Response>;
    const reads = state.reads;
    for (const path of ["/login", "/forgot-password", "/reset-password"]) {
      const response = await run(
        new NextRequest(`${ORIGIN}${path}`, { headers: { cookie: jar.header() } }),
        {},
      );
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
    // The proxy stays cheap: no database read per request.
    expect(state.reads).toBe(reads);
  });
});
