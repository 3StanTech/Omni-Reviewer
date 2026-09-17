/**
 * Auth gate (Next.js 16 proxy; formerly middleware).
 *
 * Matcher runs on app pages and /api/* (static assets excluded below).
 *
 * Unauthenticated behavior:
 * - Pages (except /login, /forgot-password, /reset-password) → redirect to /login
 * - /api/auth/* → always allowed (Auth.js handlers)
 * - POST /api/blob/upload → exempt from session 401 so Vercel Blob's
 *   onUploadCompleted callback (no session cookie) can reach handleUpload,
 *   which verifies Blob's own token. t4 owns that route; source rows are
 *   created later via a session-gated POST, not from the callback.
 * - All other /api/* → 401 JSON (not a redirect), for fetch callers
 */
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { authConfig } from "./auth.config";
import { isUsableAuthSecret } from "./lib/auth-secret";

const configuredSecret = process.env.AUTH_SECRET;

function isPublicAuthPage(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/forgot-password" ||
    pathname === "/reset-password"
  );
}

function misconfiguredResponse(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const isAuthApi =
    pathname === "/api/auth" || pathname.startsWith("/api/auth/");
  const isApi = pathname.startsWith("/api/");
  const isBlobUploadCallback =
    pathname === "/api/blob/upload" && req.method === "POST";

  // Keep public auth pages and the provider callback reachable so users see
  // the same route shape while the server refuses to mint or trust sessions.
  if (isPublicAuthPage(pathname) || isAuthApi || isBlobUploadCallback) {
    return NextResponse.next();
  }
  if (isApi) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 503 });
  }
  return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
}

// Auth.js must still initialize during a build when the deployment secret is
// absent or too short. The callback below fails closed before accepting the
// request, while this non-secret sentinel keeps the static module shape valid.
const nextAuthSecret = isUsableAuthSecret(configuredSecret)
  ? configuredSecret.trim()
  : "invalid-auth-secret-for-proxy-only-000000";

const { auth } = NextAuth({ ...authConfig, secret: nextAuthSecret });

export default auth((req) => {
  if (!isUsableAuthSecret(process.env.AUTH_SECRET)) {
    return misconfiguredResponse(req);
  }

  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth?.user;
  const isAuthApi =
    pathname === "/api/auth" || pathname.startsWith("/api/auth/");
  const isApi = pathname.startsWith("/api/");
  const isBlobUploadCallback =
    pathname === "/api/blob/upload" && req.method === "POST";

  if (isAuthApi || isBlobUploadCallback) {
    return NextResponse.next();
  }

  if (!isLoggedIn) {
    if (isApi) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }
    if (!isPublicAuthPage(pathname)) {
      const loginUrl = new URL("/login", req.nextUrl.origin);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  if (isPublicAuthPage(pathname)) {
    return NextResponse.redirect(new URL("/", req.nextUrl.origin));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    /*
     * Match all pathnames except Next static assets and common public files.
     * Includes /api/* so unauthenticated API calls get 401 JSON.
     * POST /api/blob/upload is exempted in the handler (Blob callback; see top comment).
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
