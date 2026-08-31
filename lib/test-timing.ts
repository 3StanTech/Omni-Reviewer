import "server-only";

import {
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  DEFAULT_TIMED_TEST_SECONDS,
  MAX_TIMED_TEST_SECONDS,
  MAX_TIMED_TEST_TOKEN_CHARS,
  MIN_AUTH_SECRET_CHARS,
  MIN_TIMED_TEST_SECONDS,
} from "@/lib/test-timing-constants";
import { requireAuthSecret } from "@/lib/auth-secret";

export {
  DEFAULT_TIMED_TEST_SECONDS,
  MAX_TIMED_TEST_SECONDS,
  MAX_TIMED_TEST_TOKEN_CHARS,
  MIN_AUTH_SECRET_CHARS,
  MIN_TIMED_TEST_SECONDS,
};

type TimedTestClaims = {
  version: 1;
  sessionId: string;
  userId: string;
  reviewerId: string;
  viewRevision: number;
  startedAt: number;
  expiresAt: number;
};

export type TimedTestSession = TimedTestClaims & {
  token: string;
  durationSeconds: number;
};

export type TimedTestVerification =
  | { ok: true; claims: TimedTestClaims }
  | { ok: false; reason: "invalid" | "expired" };

function secret(): string {
  return requireAuthSecret();
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function signature(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function tokenFor(claims: TimedTestClaims): string {
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${signature(payload)}`;
}

function parseClaims(value: string): TimedTestClaims | null {
  if (value.length > MAX_TIMED_TEST_TOKEN_CHARS) return null;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") return null;
  const claims = parsed as Partial<TimedTestClaims>;
  if (
    claims.version !== 1 ||
    typeof claims.sessionId !== "string" ||
    claims.sessionId.length < 16 ||
    claims.sessionId.length > 100 ||
    typeof claims.userId !== "string" ||
    claims.userId.length < 1 ||
    claims.userId.length > 200 ||
    typeof claims.reviewerId !== "string" ||
    claims.reviewerId.length < 1 ||
    claims.reviewerId.length > 200 ||
    typeof claims.viewRevision !== "number" ||
    !Number.isSafeInteger(claims.viewRevision) ||
    claims.viewRevision < 1 ||
    typeof claims.startedAt !== "number" ||
    !Number.isSafeInteger(claims.startedAt) ||
    typeof claims.expiresAt !== "number" ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= claims.startedAt
  ) {
    return null;
  }
  const duration = claims.expiresAt - claims.startedAt;
  if (
    duration < MIN_TIMED_TEST_SECONDS * 1000 ||
    duration > MAX_TIMED_TEST_SECONDS * 1000
  ) {
    return null;
  }
  return claims as TimedTestClaims;
}

export function createTimedTestSession(args: {
  userId: string;
  reviewerId: string;
  viewRevision: number;
  durationSeconds?: number;
  now?: Date;
  sessionId?: string;
  startedAt?: Date;
  expiresAt?: Date;
}): TimedTestSession {
  if (
    typeof args.userId !== "string" ||
    args.userId.length < 1 ||
    args.userId.length > 200 ||
    typeof args.reviewerId !== "string" ||
    args.reviewerId.length < 1 ||
    args.reviewerId.length > 200
  ) {
    throw new Error("Invalid timed test owner");
  }
  const durationSeconds = args.durationSeconds ?? DEFAULT_TIMED_TEST_SECONDS;
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < MIN_TIMED_TEST_SECONDS ||
    durationSeconds > MAX_TIMED_TEST_SECONDS
  ) {
    throw new Error("Invalid timed test duration");
  }
  if (!Number.isSafeInteger(args.viewRevision) || args.viewRevision < 1) {
    throw new Error("Invalid timed test revision");
  }
  const startedAt = (args.startedAt ?? args.now ?? new Date()).getTime();
  if (!Number.isSafeInteger(startedAt)) throw new Error("Invalid timed test clock");
  const expiresAt = args.expiresAt?.getTime() ?? startedAt + durationSeconds * 1000;
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= startedAt ||
    expiresAt - startedAt < MIN_TIMED_TEST_SECONDS * 1000 ||
    expiresAt - startedAt > MAX_TIMED_TEST_SECONDS * 1000
  ) {
    throw new Error("Invalid timed test deadline");
  }
  const effectiveDurationSeconds = Math.floor((expiresAt - startedAt) / 1000);
  const sessionId = args.sessionId ?? randomUUID();
  if (sessionId.length < 16 || sessionId.length > 100) {
    throw new Error("Invalid timed test session identity");
  }
  const claims: TimedTestClaims = {
    version: 1,
    sessionId,
    userId: args.userId,
    reviewerId: args.reviewerId,
    viewRevision: args.viewRevision,
    startedAt,
    expiresAt,
  };
  return { ...claims, token: tokenFor(claims), durationSeconds: effectiveDurationSeconds };
}

export function verifyTimedTestSession(
  token: string,
  now = new Date(),
): TimedTestVerification {
  if (!Number.isSafeInteger(now.getTime())) {
    return { ok: false, reason: "invalid" };
  }
  if (typeof token !== "string" || token.length > MAX_TIMED_TEST_TOKEN_CHARS) {
    return { ok: false, reason: "invalid" };
  }
  const [payload, provided] = token.split(".");
  if (!payload || !provided || token.split(".").length !== 2) {
    return { ok: false, reason: "invalid" };
  }
  let expected: string;
  try {
    expected = signature(payload);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (
    expectedBytes.length !== providedBytes.length ||
    !timingSafeEqual(expectedBytes, providedBytes)
  ) {
    return { ok: false, reason: "invalid" };
  }
  const decoded = decode(payload);
  if (!decoded) return { ok: false, reason: "invalid" };
  let claims: TimedTestClaims | null;
  try {
    claims = parseClaims(decoded);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!claims) return { ok: false, reason: "invalid" };
  if (now.getTime() >= claims.expiresAt) return { ok: false, reason: "expired" };
  if (now.getTime() < claims.startedAt) return { ok: false, reason: "invalid" };
  return { ok: true, claims };
}
