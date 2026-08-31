import { MIN_AUTH_SECRET_CHARS } from "@/lib/test-timing-constants";

/**
 * Keep the minimum secret contract in one place. Auth.js and the timed HMAC
 * must reject the same configuration, and neither path may include the secret
 * value in an error or log.
 */
export const AUTH_SECRET_ERROR =
  `AUTH_SECRET must be at least ${MIN_AUTH_SECRET_CHARS} characters and ${MIN_AUTH_SECRET_CHARS} bytes for timed sessions`;

export function isUsableAuthSecret(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed.length >= MIN_AUTH_SECRET_CHARS &&
    new TextEncoder().encode(trimmed).byteLength >= MIN_AUTH_SECRET_CHARS
  );
}

export function requireAuthSecret(value: unknown = process.env.AUTH_SECRET): string {
  if (!isUsableAuthSecret(value)) throw new Error(AUTH_SECRET_ERROR);
  return value.trim();
}
