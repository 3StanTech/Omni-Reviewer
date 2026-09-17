import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
export const MIN_PASSWORD_CHARS = 10;
export const MAX_PASSWORD_CHARS = 256;
export const PASSWORD_RESET_SUCCESS_MESSAGE =
  "If that email has an invite, we sent a reset link.";
export const PASSWORD_RESET_INVALID_MESSAGE =
  "This reset link is invalid or has expired.";
export const PASSWORD_RESET_THROTTLE_PREFIX = "reset:";

export function createResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function resetTokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isResetExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function passwordValidationError(password: string): string | null {
  if (password.length < MIN_PASSWORD_CHARS) {
    return `Password must be at least ${MIN_PASSWORD_CHARS} characters.`;
  }
  if (password.length > MAX_PASSWORD_CHARS) {
    return "Password is too long.";
  }
  return null;
}

export function resetThrottleKey(email: string): string {
  return `${PASSWORD_RESET_THROTTLE_PREFIX}${email}`;
}
