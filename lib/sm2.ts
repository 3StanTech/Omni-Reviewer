import type { CardRating } from "@/lib/types";
import { isCalendarDate } from "@/lib/date-validation";

export type ScheduleState = {
  dueAt: Date;
  intervalDays: number;
  repetitions: number;
  easeFactor: number;
};

const MIN_EASE_FACTOR = 13;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function examDeadline(examDate: string | null | undefined): Date | null {
  if (!examDate || !isCalendarDate(examDate)) return null;
  const parsed = new Date(`${examDate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A deliberately small SM-2 variant for the two-button learning loop. */
export function scheduleCardReview(
  state: ScheduleState,
  rating: CardRating,
  now = new Date(),
  examDate?: string | null,
): ScheduleState {
  const next =
    rating === "again"
      ? {
          intervalDays: 1,
          repetitions: 0,
          easeFactor: Math.max(MIN_EASE_FACTOR, state.easeFactor - 2),
        }
      : {
          intervalDays:
            state.repetitions === 0
              ? 1
              : state.repetitions === 1
                ? 6
                : Math.max(1, Math.round(state.intervalDays * state.easeFactor / 10)),
          repetitions: state.repetitions + 1,
          easeFactor: state.easeFactor,
        };
  let dueAt = addDays(now, next.intervalDays);
  const deadline = examDeadline(examDate);
  if (deadline) dueAt = deadline <= now ? now : dueAt > deadline ? deadline : dueAt;
  return { ...next, dueAt };
}
