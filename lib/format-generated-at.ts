function parseStamp(iso: string): Date | null {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

export const STAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/**
 * The one product stamp, `Oct 6, 1:36 PM` in the viewer's zone, or null if the
 * ISO stamp is invalid. Call it only on the client: the server does not know
 * the viewer's zone, so server renders show a label without the time.
 */
export function formatStamp(iso: string): string | null {
  const d = parseStamp(iso);
  if (!d) return null;
  return d.toLocaleString("en-US", STAMP_OPTIONS);
}

/** A calendar day, `Oct 9`, in the viewer's zone. */
export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * A stored `YYYY-MM-DD` day (an exam date), `Oct 23`. It names a calendar day, not an
 * instant, so it is read and printed in UTC and never shifts with the viewer's zone.
 * Anything that is not a real `YYYY-MM-DD` day comes back unchanged.
 */
export function formatCalendarDay(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return ymd;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCDate() !== Number(match[3])) return ymd;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
