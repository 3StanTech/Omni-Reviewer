import { describe, expect, it } from "vitest";

import {
  examCap,
  FSRS_PARAMS,
  fsrsNext,
  fsrsPreview,
  fsrsStateFromHistory,
  type FsrsCardState,
} from "@/lib/fsrs";
import type { CardRating } from "@/lib/types";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-01T08:00:00.000Z");
const at = (days: number) => new Date(now.getTime() + days * DAY);

describe("FSRS parameters", () => {
  it("keeps Again at tomorrow and schedules deterministically", () => {
    expect(FSRS_PARAMS.request_retention).toBe(0.9);
    expect(FSRS_PARAMS.maximum_interval).toBe(365);
    expect(FSRS_PARAMS.enable_fuzz).toBe(false);
    expect(FSRS_PARAMS.enable_short_term).toBe(false);
  });
});

describe("fsrsNext", () => {
  it("schedules Again on a new card for 1 day", () => {
    const next = fsrsNext(null, "again", now);
    expect(next.due).toEqual(at(1));
    expect(next.scheduledDays).toBe(1);
    expect(next.reps).toBe(1);
    expect(next.lastReview).toEqual(now);
  });

  it("gives Good on a new card at least 1 day, and Good then Good grows", () => {
    const first = fsrsNext(null, "good", now);
    expect(first.scheduledDays).toBeGreaterThanOrEqual(1);
    const second = fsrsNext(first, "good", first.due);
    expect(second.scheduledDays).toBeGreaterThan(first.scheduledDays);
    expect(second.stability).toBeGreaterThan(first.stability);
  });

  it("counts a lapse on Again after a review", () => {
    const first = fsrsNext(null, "good", now);
    const second = fsrsNext(first, "good", first.due);
    expect(second.state).toBe(2);
    expect(second.lapses).toBe(0);
    const lapsed = fsrsNext(second, "again", second.due);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.scheduledDays).toBe(1);
    expect(lapsed.due).toEqual(new Date(second.due.getTime() + DAY));
    expect(lapsed.state).toBe(2);
    expect(lapsed.stability).toBeLessThan(second.stability);
  });

  it("caps due at the exam before it, and makes it due now after it", () => {
    const uncapped = fsrsNext(fsrsNext(null, "good", now), "good", at(3));
    expect(uncapped.due.getTime()).toBeGreaterThan(at(5).getTime());

    const before = fsrsNext(fsrsNext(null, "good", now), "good", at(3), "2026-09-06");
    expect(before.due).toEqual(new Date("2026-09-06T00:00:00.000Z"));
    expect(before.scheduledDays).toBe(uncapped.scheduledDays);

    const after = fsrsNext(null, "good", now, "2026-08-30");
    expect(after.due).toEqual(now);

    const onDay = fsrsNext(null, "good", now, "2026-09-01");
    expect(onDay.due).toEqual(now);
  });

  it("is deterministic", () => {
    const run = () => fsrsNext(fsrsNext(null, "good", now), "again", at(4));
    expect(run()).toEqual(run());
  });
});

describe("examCap", () => {
  it("follows the SM-2 rule", () => {
    expect(examCap(at(10), now, null)).toEqual(at(10));
    expect(examCap(at(10), now, "not-a-date")).toEqual(at(10));
    expect(examCap(at(10), now, "2026-09-05")).toEqual(new Date("2026-09-05T00:00:00.000Z"));
    expect(examCap(at(2), now, "2026-09-05")).toEqual(at(2));
    expect(examCap(at(2), now, "2026-08-01")).toEqual(now);
  });
});

describe("fsrsPreview", () => {
  it("matches fsrsNext for both buttons", () => {
    const state = fsrsNext(fsrsNext(null, "good", now), "good", at(3));
    const when = at(20);
    for (const examDate of [null, "2026-09-25", "2026-12-31"]) {
      const preview = fsrsPreview(state, when, examDate);
      expect(preview.again.dueAt).toEqual(fsrsNext(state, "again", when, examDate).due);
      expect(preview.good.dueAt).toEqual(fsrsNext(state, "good", when, examDate).due);
    }
    const plain = fsrsPreview(state, when, null);
    expect(plain.good.days).toBe(fsrsNext(state, "good", when).scheduledDays);
    expect(plain.again).toEqual({ dueAt: new Date(when.getTime() + DAY), days: 1 });
    expect(fsrsPreview(null, now, null).again).toEqual({ dueAt: at(1), days: 1 });
  });
});

describe("fsrsStateFromHistory", () => {
  it("returns null for an empty history", () => {
    expect(fsrsStateFromHistory([], now)).toBeNull();
  });

  it("equals step-by-step fsrsNext, in reviewedAt order", () => {
    const createdAt = new Date("2026-08-31T12:00:00.000Z");
    const reviews: { rating: CardRating; reviewedAt: Date }[] = [
      { rating: "good", reviewedAt: now },
      { rating: "good", reviewedAt: at(3) },
      { rating: "again", reviewedAt: at(15) },
      { rating: "good", reviewedAt: at(16) },
      { rating: "good", reviewedAt: at(25) },
    ];
    let expected: FsrsCardState | null = null;
    for (const review of reviews) expected = fsrsNext(expected, review.rating, review.reviewedAt);

    const shuffled = [reviews[3], reviews[0], reviews[4], reviews[2], reviews[1]];
    const replayed = fsrsStateFromHistory(shuffled, createdAt);
    expect(replayed).toEqual(expected);
    expect(replayed?.reps).toBe(5);
    expect(replayed?.lapses).toBe(1);
  });
});
