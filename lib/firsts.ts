import { readLocalStorage, writeLocalStorage } from "@/lib/safe-storage";

/** First-time moments worth a cheer. */
export type FirstKind = "pack" | "sitting" | "all-due";

/** The owner's facts from `GET /api/firsts`. */
export type FirstFacts = { generatedPacks: number; completedSittings: number; dueToday: number };

/** Device flags: set once a kind's answer is final, so later events skip the fetch. */
export const FIRST_KEYS: Record<FirstKind, string> = {
  pack: "omni-first-pack",
  sitting: "omni-first-sitting",
  "all-due": "omni-first-all-due",
};

/**
 * Whether this event is the first of its kind. A set device flag always wins.
 * The all-due day has no stored history, so it relies on the flag alone.
 */
export function shouldCelebrate(kind: FirstKind, facts: FirstFacts, flagged: boolean): boolean {
  if (flagged) return false;
  switch (kind) {
    case "pack":
      return facts.generatedPacks === 1;
    case "sitting":
      return facts.completedSittings === 1;
    case "all-due":
      return facts.dueToday === 0;
  }
}

/** Whether the facts settle this kind for good on this device (first shown, or already past it). */
function isFinal(kind: FirstKind, facts: FirstFacts): boolean {
  switch (kind) {
    case "pack":
      return facts.generatedPacks >= 1;
    case "sitting":
      return facts.completedSittings >= 1;
    case "all-due":
      return facts.dueToday === 0;
  }
}

function isFacts(value: unknown): value is FirstFacts {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.generatedPacks === "number" &&
    typeof record.completedSittings === "number" &&
    typeof record.dueToday === "number"
  );
}

/**
 * Client helper for an event site: reads the device flag, asks the server for
 * the facts, sets the flag once the answer is final and returns whether to cheer.
 * Network or parse failures never cheer and leave the flag unset.
 */
export async function celebrateIfFirst(kind: FirstKind): Promise<boolean> {
  const key = FIRST_KEYS[kind];
  if (readLocalStorage(key) !== null) return false;
  let facts: unknown;
  try {
    const response = await fetch("/api/firsts", { cache: "no-store" });
    if (!response.ok) return false;
    facts = await response.json();
  } catch {
    return false;
  }
  if (!isFacts(facts)) return false;
  const celebrate = shouldCelebrate(kind, facts, false);
  if (isFinal(kind, facts)) writeLocalStorage(key, "1");
  return celebrate;
}
