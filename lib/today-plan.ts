import { newCardAllowance } from "@/lib/pacing";
import { MASTERY_WEAK_THRESHOLD, type MasteryResult } from "@/lib/mastery";
import { isCalendarDate } from "@/lib/date-validation";

/**
 * The Today plan: one pure function from per-pack numbers to the Today bar,
 * the "Do first" list and the exam pacing strips. No data access here.
 *
 * Time estimate constants:
 * - 8 seconds per due card (to review or new)
 * - 45 seconds per re-test question (the section's missed items from its
 *   latest sitting, at least MIN_RETEST_QUESTIONS)
 * - re-read time is the section's words at 200 words per minute, rounded up
 * - the total is rounded to the nearest 5 minutes, and is at least 5 when
 *   there is anything to do
 */
export const SECONDS_PER_DUE_CARD = 8;
export const SECONDS_PER_RETEST_QUESTION = 45;
export const MIN_RETEST_QUESTIONS = 5;
export const WORDS_PER_MINUTE = 200;
export const MAX_RETESTS = 2;
/** A strip longer than this shows only today, the next few days and the exam day. */
export const MAX_STRIP_COLUMNS = 14;
const CONDENSED_LEAD_DAYS = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TodayPack = {
  id: string;
  topicId: string;
  topicName: string;
  name: string;
  examDate: string | null;
  /** Cards due today: `reviewDue + newToday`. */
  dueToday: number;
  /** Due cards studied before. */
  reviewDue: number;
  /** New cards within today's allowance. */
  newToday: number;
  newRemaining: number;
  introducedLast24h: number;
  mastery: MasteryResult | null;
  /** Words per section id, for the re-read estimate. */
  sectionWords?: Record<string, number>;
  /** Items missed in the latest sitting per section id, for the re-test estimate. */
  missedBySection?: Record<string, number>;
};

export type DoFirstItem =
  | { kind: "review"; dueCards: number; packCount: number; packId: string }
  | { kind: "retest"; packId: string; sectionId: string; title: string; score: number; missed: number }
  | { kind: "reread"; packId: string; sectionId: string; title: string; score: number; minutes: number };

export type PacingStrip = { date: string; newCards: number }[];

export type PacingGroup = {
  topicName: string;
  examDate: string;
  days: number;
  packCount: number;
  strip: PacingStrip;
};

export type TodayBarData = {
  /** Every card due today: `reviewCards + newCards`. */
  dueCards: number;
  reviewCards: number;
  newCards: number;
  weakSections: number;
  exam: { topicName: string; days: number } | null;
  minutes: number;
};

export type TodayPlan = {
  bar: TodayBarData;
  doFirst: DoFirstItem[];
  pacing: PacingGroup[];
  empty: boolean;
};

function utcDay(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** Calendar days from now's UTC date to the exam date; null when the date is missing, invalid or passed. */
function upcomingExamDays(examDate: string | null, now: Date): number | null {
  if (!examDate || !isCalendarDate(examDate)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((utcDay(examDate) - today) / DAY_MS);
  return days >= 0 ? days : null;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * New cards planned per day for one pack, today through the exam day,
 * by iterating `newCardAllowance` forward and subtracting what it introduces.
 * Today uses the real `introducedLast24h`. Each later day assumes the cards
 * introduced the day before have aged out of the 24 hour window.
 * New cards only: review load is not projected.
 */
function newCardsByDay(pack: TodayPack, totalDays: number, now: Date): number[] {
  const perDay: number[] = [];
  let remaining = Math.max(0, pack.newRemaining);
  for (let offset = 0; offset <= totalDays; offset += 1) {
    const allowance = newCardAllowance({
      examDate: pack.examDate,
      newRemaining: remaining,
      introducedLast24h: offset === 0 ? pack.introducedLast24h : 0,
      now: new Date(now.getTime() + offset * DAY_MS),
    });
    const introduced = Math.min(allowance === Infinity ? remaining : allowance, remaining);
    perDay.push(introduced);
    remaining -= introduced;
  }
  return perDay;
}

function buildPacing(packs: TodayPack[], now: Date): PacingGroup[] {
  const groups = new Map<string, { topicName: string; examDate: string; days: number; packs: TodayPack[] }>();
  for (const pack of packs) {
    const days = upcomingExamDays(pack.examDate, now);
    if (days === null || !pack.examDate) continue;
    const key = `${pack.topicId}|${pack.examDate}`;
    const group = groups.get(key) ?? { topicName: pack.topicName, examDate: pack.examDate, days, packs: [] };
    group.packs.push(pack);
    groups.set(key, group);
  }

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return [...groups.values()]
    .sort((a, b) => a.days - b.days || a.topicName.localeCompare(b.topicName))
    .map((group) => {
      const totals = new Array<number>(group.days + 1).fill(0);
      for (const pack of group.packs) {
        newCardsByDay(pack, group.days, now).forEach((count, offset) => {
          totals[offset] += count;
        });
      }
      const offsets =
        group.days + 1 <= MAX_STRIP_COLUMNS
          ? totals.map((_, offset) => offset)
          : [...Array.from({ length: CONDENSED_LEAD_DAYS + 1 }, (_, offset) => offset), group.days];
      return {
        topicName: group.topicName,
        examDate: group.examDate,
        days: group.days,
        packCount: group.packs.length,
        strip: offsets.map((offset) => ({ date: isoDay(today + offset * DAY_MS), newCards: totals[offset] })),
      };
    });
}

type WeakSection = { pack: TodayPack; sectionId: string; title: string; score: number; items: number; order: number };

function weakSections(packs: TodayPack[]): WeakSection[] {
  const found: WeakSection[] = [];
  for (const pack of packs) {
    for (const section of pack.mastery?.sections ?? []) {
      if (section.score !== null && section.score < MASTERY_WEAK_THRESHOLD) {
        found.push({
          pack,
          sectionId: section.id,
          title: section.title,
          score: section.score,
          items: section.items,
          order: found.length,
        });
      }
    }
  }
  return found.sort((a, b) => a.score - b.score || b.items - a.items || a.order - b.order);
}

export function buildTodayPlan({ packs, now }: { packs: TodayPack[]; now: Date }): TodayPlan {
  const dueCards = packs.reduce((sum, pack) => sum + Math.max(0, pack.dueToday), 0);
  const reviewCards = packs.reduce((sum, pack) => sum + Math.max(0, pack.reviewDue), 0);
  const newCards = packs.reduce((sum, pack) => sum + Math.max(0, pack.newToday), 0);
  const weak = weakSections(packs);

  const doFirst: DoFirstItem[] = [];
  let seconds = dueCards * SECONDS_PER_DUE_CARD;

  if (dueCards > 0) {
    const duePacks = packs.filter((pack) => pack.dueToday > 0);
    const busiest = duePacks.reduce((best, pack) => (pack.dueToday > best.dueToday ? pack : best));
    doFirst.push({ kind: "review", dueCards, packCount: duePacks.length, packId: busiest.id });
  }

  for (const section of weak.slice(0, MAX_RETESTS)) {
    const missed = Math.max(0, section.pack.missedBySection?.[section.sectionId] ?? 0);
    seconds += Math.max(MIN_RETEST_QUESTIONS, missed) * SECONDS_PER_RETEST_QUESTION;
    doFirst.push({
      kind: "retest",
      packId: section.pack.id,
      sectionId: section.sectionId,
      title: section.title,
      score: section.score,
      missed,
    });
  }

  // Prefer a weak section that is not already a re-test; fall back to the weakest overall.
  const weakest = weak[MAX_RETESTS] ?? weak[0];
  if (weakest) {
    const words = Math.max(0, weakest.pack.sectionWords?.[weakest.sectionId] ?? 0);
    // An unread-length section still takes a minute to open and skim.
    const minutes = Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
    seconds += minutes * 60;
    doFirst.push({
      kind: "reread",
      packId: weakest.pack.id,
      sectionId: weakest.sectionId,
      title: weakest.title,
      score: weakest.score,
      minutes,
    });
  }

  const minutes = doFirst.length === 0 ? 0 : Math.max(5, Math.round(seconds / 60 / 5) * 5);

  let exam: TodayBarData["exam"] = null;
  let nearest = Infinity;
  for (const pack of packs) {
    const days = upcomingExamDays(pack.examDate, now);
    if (days !== null && days < nearest) {
      nearest = days;
      exam = { topicName: pack.topicName, days };
    }
  }

  return {
    bar: { dueCards, reviewCards, newCards, weakSections: weak.length, exam, minutes },
    doFirst,
    pacing: buildPacing(packs, now),
    empty: dueCards === 0 && weak.length === 0,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What "weak" means wherever a weak section is marked. */
export const WEAK_SECTION_DEFINITION = "Under 60% correct on 3 or more answers";

export type TodayBarPart = { text: string; weak?: boolean };

/** The Today bar's parts in order; zero and null parts are omitted. The weak part is flagged for its definition. */
export function todayBarParts(bar: TodayBarData): TodayBarPart[] {
  const parts: TodayBarPart[] = [];
  if (bar.reviewCards > 0) parts.push({ text: `${bar.reviewCards} to review` });
  if (bar.newCards > 0) parts.push({ text: `${bar.newCards} new` });
  if (bar.weakSections > 0) parts.push({ text: plural(bar.weakSections, "weak section", "weak sections"), weak: true });
  if (bar.exam) {
    parts.push({
      text:
        bar.exam.days === 0
          ? `${bar.exam.topicName} exam today`
          : `${bar.exam.topicName} exam in ${plural(bar.exam.days, "day", "days")}`,
    });
  }
  if (bar.minutes > 0) parts.push({ text: `About ${bar.minutes} min` });
  return parts;
}

/** The Today bar's text segments; zero and null segments are omitted. */
export function todayBarSegments(bar: TodayBarData): string[] {
  return todayBarParts(bar).map((part) => part.text);
}

/** A pack's due split, "2 to review · 5 new"; zero parts are omitted, empty when both are zero. */
export function dueSplitCopy(review: number, fresh: number): string {
  const parts: string[] = [];
  if (review > 0) parts.push(`${review} to review`);
  if (fresh > 0) parts.push(`${fresh} new`);
  return parts.join(" · ");
}
