import { citedPages, pagesOverlap, sectionsFromLockedIn } from "@/lib/mastery";

/**
 * Copy for the end-of-sitting recap. Pure; sections and the overlap rule are
 * the same ones section mastery uses.
 */

/** The Locked In section most missed this sitting; ties go to the earlier section. */
export function recapFocusSection({
  lockedIn,
  missedTexts,
}: {
  lockedIn: string | null;
  missedTexts: string[];
}): { id: string; title: string; misses: number } | null {
  if (!lockedIn) return null;
  const sections = sectionsFromLockedIn(lockedIn);
  const missedPages = missedTexts.map((text) => citedPages(text));
  let best: { id: string; title: string; misses: number } | null = null;
  for (const section of sections) {
    const misses = missedPages.filter((pages) => pagesOverlap(pages, section.pages)).length;
    if (misses > 0 && (best === null || misses > best.misses)) best = { id: section.id, title: section.title, misses };
  }
  return best;
}

export type SectionBreakdownRow = { id: string; title: string; correct: number; total: number };

/**
 * Correct answers per Locked In section this sitting, in document order. An
 * item counts for the first section its citations overlap; items with no
 * matching section go to "Other", last. Sections without items are left out.
 */
export function sectionBreakdown({
  lockedIn,
  items,
}: {
  lockedIn: string | null;
  items: Array<{ text: string; correct: boolean }>;
}): SectionBreakdownRow[] {
  const sections = lockedIn ? sectionsFromLockedIn(lockedIn) : [];
  const rows = sections.map((section) => ({ id: section.id, title: section.title, correct: 0, total: 0 }));
  const other = { id: "other", title: "Other", correct: 0, total: 0 };
  for (const item of items) {
    const pages = citedPages(item.text);
    const index = sections.findIndex((section) => pagesOverlap(pages, section.pages));
    const row = index >= 0 ? rows[index] : other;
    row.total += 1;
    if (item.correct) row.correct += 1;
  }
  return [...rows, other].filter((row) => row.total > 0);
}

export function formatSittingDuration(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60) return "over an hour";
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}

function dayPhrase(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** Calendar days in local time from `now` to `date`. */
function calendarDaysUntil(date: Date, now: Date): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** When the cards rated this sitting come back, or null with none. */
export function nextReturnCopy(dueAts: string[], now: Date): string | null {
  if (dueAts.length === 0) return null;
  const days = dueAts.map((dueAt) => Math.max(0, calendarDaysUntil(new Date(dueAt), now)));
  const min = Math.min(...days);
  const max = Math.max(...days);
  if (min === max) return `Rated cards come back ${dayPhrase(min)}`;
  return `Rated cards come back between ${dayPhrase(min)} and ${dayPhrase(max)}`;
}
