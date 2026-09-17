export const LOGIN_THROTTLE_MAX_FAILURES = 5;
export const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_THROTTLE_LOCK_MS = 15 * 60 * 1000;
export const LOGIN_THROTTLE_LOCKED_MESSAGE =
  "Too many sign-in attempts. Try again in a few minutes.";

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type LoginThrottleState = {
  failedCount: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
};

export function isLoginLocked(
  row: { lockedUntil: Date | null },
  now: Date,
): boolean {
  return row.lockedUntil != null && row.lockedUntil.getTime() > now.getTime();
}

export function nextFailureState(
  row: LoginThrottleState | null,
  now: Date,
): LoginThrottleState {
  if (row && isLoginLocked(row, now)) {
    return {
      failedCount: row.failedCount,
      windowStartedAt: row.windowStartedAt,
      lockedUntil: row.lockedUntil,
    };
  }

  const lockExpired =
    row?.lockedUntil != null && row.lockedUntil.getTime() <= now.getTime();
  const windowExpired =
    !row ||
    now.getTime() - row.windowStartedAt.getTime() >= LOGIN_THROTTLE_WINDOW_MS;

  if (!row || windowExpired || lockExpired) {
    return {
      failedCount: 1,
      windowStartedAt: now,
      lockedUntil: null,
    };
  }

  const failedCount = row.failedCount + 1;
  return {
    failedCount,
    windowStartedAt: row.windowStartedAt,
    lockedUntil:
      failedCount >= LOGIN_THROTTLE_MAX_FAILURES
        ? new Date(now.getTime() + LOGIN_THROTTLE_LOCK_MS)
        : null,
  };
}
