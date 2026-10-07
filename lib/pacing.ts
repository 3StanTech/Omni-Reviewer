import { isCalendarDate } from "@/lib/date-validation";
import { formatDay } from "@/lib/format-generated-at";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The last days before an exam are held back for second reviews. */
const HOLDBACK_DAYS = 2;

/** Whole days from `now` to the exam's UTC midnight (floor, at least 0). */
export function daysUntilExam(examDate: string | null | undefined, now: Date): number | null {
  if (!examDate || !isCalendarDate(examDate)) return null;
  const deadline = new Date(`${examDate}T00:00:00.000Z`);
  if (Number.isNaN(deadline.getTime())) return null;
  return Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / DAY_MS));
}

/** New cards still allowed today. Unlimited without an exam date. */
export function newCardAllowance({
  examDate,
  newRemaining,
  introducedLast24h,
  now,
}: {
  examDate?: string | null;
  newRemaining: number;
  introducedLast24h: number;
  now: Date;
}): number {
  const days = daysUntilExam(examDate, now);
  if (days === null) return Infinity;
  const newPerDay =
    days <= HOLDBACK_DAYS
      ? newRemaining
      : Math.ceil(newRemaining / Math.max(1, days - HOLDBACK_DAYS));
  return Math.max(0, newPerDay - introducedLast24h);
}

/**
 * Today's queue: due review cards by `dueAt`, then due new cards by
 * `createdAt` up to the pacing allowance. Archived cards are excluded.
 */
export function selectTodayCards<
  T extends { id: string; dueAt: Date; createdAt: Date; isNew: boolean; archivedAt?: Date | null },
>(
  cards: T[],
  opts: { examDate?: string | null; introducedLast24h: number; now: Date },
): T[] {
  const live = cards.filter((card) => !card.archivedAt);
  const nowMs = opts.now.getTime();
  const isDue = (card: T) => card.dueAt.getTime() <= nowMs;
  const reviews = live
    .filter((card) => !card.isNew && isDue(card))
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const allowance = newCardAllowance({
    examDate: opts.examDate,
    newRemaining: live.filter((card) => card.isNew).length,
    introducedLast24h: opts.introducedLast24h,
    now: opts.now,
  });
  const fresh = live
    .filter((card) => card.isNew && isDue(card))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, allowance === Infinity ? undefined : allowance);
  return [...reviews, ...fresh];
}

/**
 * A card's due line: "Due today" for any card due by the end of the local day,
 * overdue and never-reviewed cards included (a new card is due from creation),
 * otherwise the due date.
 */
export function dueLabel(dueAt: Date, now: Date): string {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  return dueAt.getTime() <= endOfToday.getTime() ? "Due today" : `Due ${formatDay(dueAt)}`;
}
