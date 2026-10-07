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
