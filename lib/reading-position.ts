export type ReadingPosition = { headingId: string | null; offset: number };

export function readingPositionKey(userId: string, reviewerId: string, kind: string, contentRevision: number): string {
  return `omni-reading-position:${userId}:${reviewerId}:${kind}:${contentRevision}`;
}

export function parseReadingPosition(value: unknown): ReadingPosition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { headingId?: unknown; offset?: unknown };
  if ((record.headingId !== null && typeof record.headingId !== "string") || typeof record.offset !== "number" || !Number.isFinite(record.offset) || record.offset < 0 || record.offset > 1) return null;
  return { headingId: record.headingId === undefined ? null : record.headingId, offset: record.offset };
}

export function readReadingPosition(storage: Pick<Storage, "getItem"> | null, key: string): ReadingPosition | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? parseReadingPosition(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeReadingPosition(storage: Pick<Storage, "setItem"> | null, key: string, position: ReadingPosition): boolean {
  if (!storage || !parseReadingPosition(position)) return false;
  try { storage.setItem(key, JSON.stringify(position)); return true; } catch { return false; }
}
