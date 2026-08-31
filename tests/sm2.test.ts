import { describe, expect, it } from "vitest";

import { scheduleCardReview } from "@/lib/sm2";

const now = new Date("2026-08-30T00:00:00.000Z");

describe("two-button SM-2 schedule", () => {
  it("puts Again back into a one-day interval and reduces ease", () => {
    const next = scheduleCardReview(
      {
        dueAt: now,
        intervalDays: 6,
        repetitions: 2,
        easeFactor: 25,
      },
      "again",
      now,
    );
    expect(next.intervalDays).toBe(1);
    expect(next.repetitions).toBe(0);
    expect(next.easeFactor).toBe(23);
    expect(next.dueAt.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("uses the simple 1, 6, then ease-scaled Good intervals", () => {
    const first = scheduleCardReview({ dueAt: now, intervalDays: 0, repetitions: 0, easeFactor: 25 }, "good", now);
    const second = scheduleCardReview({ ...first }, "good", now);
    const third = scheduleCardReview({ ...second }, "good", now);
    expect(first.intervalDays).toBe(1);
    expect(second.intervalDays).toBe(6);
    expect(third.intervalDays).toBe(15);
  });

  it("does not schedule past the exam date", () => {
    const next = scheduleCardReview(
      { dueAt: now, intervalDays: 20, repetitions: 4, easeFactor: 25 },
      "good",
      now,
      "2026-09-02",
    );
    expect(next.dueAt.toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });

  it("makes same-day and past exam dates immediately due", () => {
    const sameDay = scheduleCardReview(
      { dueAt: now, intervalDays: 0, repetitions: 0, easeFactor: 25 },
      "good",
      now,
      "2026-08-30",
    );
    const past = scheduleCardReview(
      { dueAt: now, intervalDays: 0, repetitions: 0, easeFactor: 25 },
      "good",
      now,
      "2026-08-29",
    );
    expect(sameDay.dueAt).toEqual(now);
    expect(past.dueAt).toEqual(now);
  });

  it("ignores an impossible exam date rather than applying a normalized date", () => {
    const next = scheduleCardReview(
      { dueAt: now, intervalDays: 0, repetitions: 0, easeFactor: 25 },
      "good",
      now,
      "2026-02-29",
    );
    expect(next.dueAt.toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });
});
