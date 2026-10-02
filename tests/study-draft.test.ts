import { describe, expect, it } from "vitest";

import { MAX_GENERATED_MARKDOWN_CHARS } from "@/lib/learning-limits";
import { clearStudyDraft, parseStudyDraft, readStudyDraft, studyDraftKey, writeStudyDraft } from "@/lib/study-draft";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

const throwing = {
  getItem: () => { throw new DOMException("Access denied", "SecurityError"); },
  setItem: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); },
  removeItem: () => { throw new DOMException("Access denied", "SecurityError"); },
};

const draft = { content: "# Edited\n\nA changed line.", baseRevision: 4, savedAt: 1_700_000_000_000 };

describe("study draft storage", () => {
  it("keys drafts by user, pack and document kind", () => {
    expect(studyDraftKey("u1", "r1", "locked_in")).toBe("omni-study-draft:u1:r1:locked_in");
    expect(studyDraftKey("u1", "r1", "summary")).not.toBe(studyDraftKey("u1", "r1", "locked_in"));
  });

  it("round trips a draft and clears it", () => {
    const storage = memoryStorage();
    const key = studyDraftKey("u1", "r1", "summary");
    expect(writeStudyDraft(storage, key, draft)).toBe(true);
    expect(readStudyDraft(storage, key)).toEqual(draft);
    expect(clearStudyDraft(storage, key)).toBe(true);
    expect(readStudyDraft(storage, key)).toBeNull();
  });

  it("rejects malformed JSON and wrong shapes", () => {
    const storage = memoryStorage();
    storage.items.set("bad-json", "{not json");
    storage.items.set("array", "[]");
    storage.items.set("number", "7");
    expect(readStudyDraft(storage, "bad-json")).toBeNull();
    expect(readStudyDraft(storage, "array")).toBeNull();
    expect(readStudyDraft(storage, "number")).toBeNull();
    expect(readStudyDraft(storage, "missing")).toBeNull();
    expect(parseStudyDraft(null)).toBeNull();
    expect(parseStudyDraft({ ...draft, content: 42 })).toBeNull();
    expect(parseStudyDraft({ ...draft, baseRevision: "4" })).toBeNull();
    expect(parseStudyDraft({ ...draft, savedAt: undefined })).toBeNull();
  });

  it("rejects negative, fractional and non-finite numbers", () => {
    expect(parseStudyDraft({ ...draft, baseRevision: -1 })).toBeNull();
    expect(parseStudyDraft({ ...draft, baseRevision: 1.5 })).toBeNull();
    expect(parseStudyDraft({ ...draft, baseRevision: Number.NaN })).toBeNull();
    expect(parseStudyDraft({ ...draft, savedAt: -5 })).toBeNull();
    expect(parseStudyDraft({ ...draft, savedAt: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseStudyDraft({ ...draft, baseRevision: 0, savedAt: 0 })).toEqual({ ...draft, baseRevision: 0, savedAt: 0 });
  });

  it("refuses oversize content on write and read", () => {
    const storage = memoryStorage();
    const oversize = { ...draft, content: "x".repeat(MAX_GENERATED_MARKDOWN_CHARS + 1) };
    expect(writeStudyDraft(storage, "k", oversize)).toBe(false);
    expect(storage.items.size).toBe(0);
    storage.items.set("k", JSON.stringify(oversize));
    expect(readStudyDraft(storage, "k")).toBeNull();
    expect(parseStudyDraft({ ...draft, content: "x".repeat(MAX_GENERATED_MARKDOWN_CHARS) })).not.toBeNull();
  });

  it("refuses invalid drafts on write", () => {
    const storage = memoryStorage();
    expect(writeStudyDraft(storage, "k", { ...draft, baseRevision: -1 })).toBe(false);
    expect(storage.items.size).toBe(0);
  });

  it("tolerates missing storage", () => {
    expect(readStudyDraft(null, "k")).toBeNull();
    expect(writeStudyDraft(null, "k", draft)).toBe(false);
    expect(clearStudyDraft(null, "k")).toBe(false);
  });

  it("fails closed when storage throws", () => {
    expect(readStudyDraft(throwing, "k")).toBeNull();
    expect(writeStudyDraft(throwing, "k", draft)).toBe(false);
    expect(clearStudyDraft(throwing, "k")).toBe(false);
  });
});
