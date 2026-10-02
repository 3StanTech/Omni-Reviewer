import { MAX_GENERATED_MARKDOWN_CHARS } from "@/lib/learning-limits";

/** An unsaved Locked In or Summary edit kept on this device until it is saved or discarded. */
export type StudyDraft = { content: string; baseRevision: number; savedAt: number };

export function studyDraftKey(userId: string, reviewerId: string, kind: string): string {
  return `omni-study-draft:${userId}:${reviewerId}:${kind}`;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseStudyDraft(value: unknown): StudyDraft | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { content?: unknown; baseRevision?: unknown; savedAt?: unknown };
  if (typeof record.content !== "string" || record.content.length > MAX_GENERATED_MARKDOWN_CHARS) return null;
  if (!isNonNegativeNumber(record.baseRevision) || !Number.isInteger(record.baseRevision) || !isNonNegativeNumber(record.savedAt)) return null;
  return { content: record.content, baseRevision: record.baseRevision, savedAt: record.savedAt };
}

export function readStudyDraft(storage: Pick<Storage, "getItem"> | null, key: string): StudyDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? parseStudyDraft(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeStudyDraft(storage: Pick<Storage, "setItem"> | null, key: string, draft: StudyDraft): boolean {
  const parsed = parseStudyDraft(draft);
  if (!storage || !parsed) return false;
  try { storage.setItem(key, JSON.stringify(parsed)); return true; } catch { return false; }
}

export function clearStudyDraft(storage: Pick<Storage, "removeItem"> | null, key: string): boolean {
  if (!storage) return false;
  try { storage.removeItem(key); return true; } catch { return false; }
}
