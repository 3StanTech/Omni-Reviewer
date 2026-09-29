import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  type Card,
  type Grade,
} from "ts-fsrs";

import { isCalendarDate } from "@/lib/date-validation";
import type { CardRating } from "@/lib/types";

/**
 * Again stays "tomorrow": short-term steps are off so FSRS never schedules
 * minute-level relearning inside a finite session. Fuzz is off so schedules
 * are deterministic. Default FSRS-6 weights, no optimizer.
 */
export const FSRS_PARAMS = generatorParameters({
  request_retention: 0.9,
  maximum_interval: 365,
  enable_fuzz: false,
  enable_short_term: false,
});

const scheduler = fsrs(FSRS_PARAMS);
const DAY_MS = 24 * 60 * 60 * 1000;

export type FsrsCardState = {
  state: 0 | 1 | 2 | 3;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  scheduledDays: number;
  lastReview: Date | null;
  due: Date;
};

function toGrade(rating: CardRating): Grade {
  return rating === "again" ? Rating.Again : Rating.Good;
}

function toCard(state: FsrsCardState | null, now: Date): Card {
  if (!state) return createEmptyCard(now);
  const lastReview = state.lastReview ?? undefined;
  return {
    due: state.due,
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: lastReview
      ? Math.max(0, Math.floor((now.getTime() - lastReview.getTime()) / DAY_MS))
      : 0,
    scheduled_days: state.scheduledDays,
    learning_steps: 0,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    last_review: lastReview,
  };
}

function fromCard(card: Card): FsrsCardState {
  return {
    state: card.state as FsrsCardState["state"],
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    scheduledDays: card.scheduled_days,
    lastReview: card.last_review ?? null,
    due: card.due,
  };
}

function examDeadline(examDate: string | null | undefined): Date | null {
  if (!examDate || !isCalendarDate(examDate)) return null;
  const parsed = new Date(`${examDate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Caps a due date at the exam (UTC midnight). A past exam makes the card due now. */
export function examCap(due: Date, now: Date, examDate?: string | null): Date {
  const deadline = examDeadline(examDate);
  if (!deadline) return due;
  if (deadline <= now) return now;
  return due > deadline ? deadline : due;
}

/**
 * One FSRS step. Product rule: Again always means tomorrow, so its due date
 * and `scheduledDays` are clamped to 1 day while FSRS keeps the updated
 * stability, difficulty, lapses and state.
 */
function step(state: FsrsCardState | null, rating: CardRating, now: Date): FsrsCardState {
  const next = fromCard(scheduler.next(toCard(state, now), now, toGrade(rating)).card);
  if (rating !== "again") return next;
  return { ...next, due: new Date(now.getTime() + DAY_MS), scheduledDays: 1 };
}

/**
 * Next state after one review. `null` means a new card. The exam cap is
 * applied to `due` only; `scheduledDays` keeps the FSRS interval.
 */
export function fsrsNext(
  state: FsrsCardState | null,
  rating: CardRating,
  now: Date,
  examDate?: string | null,
): FsrsCardState {
  const next = step(state, rating, now);
  return { ...next, due: examCap(next.due, now, examDate) };
}

function previewOf(state: FsrsCardState | null, rating: CardRating, now: Date, examDate?: string | null) {
  const dueAt = fsrsNext(state, rating, now, examDate).due;
  return { dueAt, days: Math.max(0, Math.round((dueAt.getTime() - now.getTime()) / DAY_MS)) };
}

/** Due dates each button would give, matching `fsrsNext`. */
export function fsrsPreview(
  state: FsrsCardState | null,
  now: Date,
  examDate?: string | null,
): { again: { dueAt: Date; days: number }; good: { dueAt: Date; days: number } } {
  return {
    again: previewOf(state, "again", now, examDate),
    good: previewOf(state, "good", now, examDate),
  };
}

/**
 * Rebuilds FSRS state by replaying reviews in ascending `reviewedAt` order,
 * starting from an empty card created at `createdAt`. No exam cap is applied.
 */
export function fsrsStateFromHistory(
  reviews: { rating: CardRating; reviewedAt: Date }[],
  createdAt: Date,
): FsrsCardState | null {
  if (reviews.length === 0) return null;
  const ordered = [...reviews].sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime());
  let state: FsrsCardState = fromCard(createEmptyCard(createdAt));
  for (const review of ordered) state = step(state, review.rating, review.reviewedAt);
  return state;
}
