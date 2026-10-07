import { describe, expect, it } from "vitest";

import { daysUntilExam, dueLabel, newCardAllowance, selectTodayCards } from "@/lib/pacing";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-01T08:00:00.000Z");
const at = (days: number) => new Date(now.getTime() + days * DAY);

describe("daysUntilExam", () => {
  it("floors whole days to the exam's UTC midnight", () => {
    expect(daysUntilExam(null, now)).toBeNull();
    expect(daysUntilExam("bad", now)).toBeNull();
    expect(daysUntilExam("2026-09-13", now)).toBe(11);
    expect(daysUntilExam("2026-09-02", now)).toBe(0);
    expect(daysUntilExam("2026-08-20", now)).toBe(0);
  });
});

describe("newCardAllowance", () => {
  it("is unlimited without an exam", () => {
    expect(newCardAllowance({ examDate: null, newRemaining: 40, introducedLast24h: 5, now })).toBe(
      Infinity,
    );
  });

  it("gives 4 a day for 40 new cards with the exam 12 days away", () => {
    const examDate = "2026-09-13";
    const twelveOut = new Date("2026-09-01T00:00:00.000Z");
    expect(daysUntilExam(examDate, twelveOut)).toBe(12);
    expect(newCardAllowance({ examDate, newRemaining: 40, introducedLast24h: 0, now: twelveOut })).toBe(4);
  });

  it("gives all remaining with 2 days or less", () => {
    const base = { newRemaining: 17, introducedLast24h: 0 };
    expect(newCardAllowance({ ...base, examDate: "2026-09-03", now: new Date("2026-09-01T00:00:00.000Z") })).toBe(17);
    expect(newCardAllowance({ ...base, examDate: "2026-09-02", now })).toBe(17);
    expect(newCardAllowance({ ...base, examDate: "2026-08-01", now })).toBe(17);
  });

  it("subtracts cards introduced in the last 24 hours", () => {
    const base = { examDate: "2026-09-13", newRemaining: 40, now: new Date("2026-09-01T00:00:00.000Z") };
    expect(newCardAllowance({ ...base, introducedLast24h: 3 })).toBe(1);
    expect(newCardAllowance({ ...base, introducedLast24h: 9 })).toBe(0);
  });
});

describe("selectTodayCards", () => {
  type C = { id: string; dueAt: Date; createdAt: Date; isNew: boolean; archivedAt?: Date | null };
  const cards: C[] = [
    { id: "r-late", dueAt: at(-1), createdAt: at(-30), isNew: false },
    { id: "r-early", dueAt: at(-5), createdAt: at(-20), isNew: false },
    { id: "r-future", dueAt: at(2), createdAt: at(-40), isNew: false },
    { id: "r-archived", dueAt: at(-9), createdAt: at(-50), isNew: false, archivedAt: at(-1) },
    { id: "n-3", dueAt: at(-1), createdAt: at(-3), isNew: true },
    { id: "n-1", dueAt: at(-1), createdAt: at(-10), isNew: true },
    { id: "n-2", dueAt: at(-1), createdAt: at(-5), isNew: true },
    { id: "n-archived", dueAt: at(-1), createdAt: at(-60), isNew: true, archivedAt: at(-1) },
  ];

  it("orders due reviews by dueAt, then new cards by createdAt, without archived cards", () => {
    const ids = selectTodayCards(cards, { introducedLast24h: 0, now }).map((c) => c.id);
    expect(ids).toEqual(["r-early", "r-late", "n-1", "n-2", "n-3"]);
  });

  it("limits new cards to the pacing allowance", () => {
    // 3 live new cards, exam 12 days out: ceil(3 / 10) = 1 a day.
    const opts = { examDate: "2026-09-13", now: new Date("2026-09-01T00:00:00.000Z") };
    const shifted = cards.map((c) => ({ ...c, dueAt: new Date(c.dueAt.getTime() - DAY) }));
    expect(selectTodayCards(shifted, { ...opts, introducedLast24h: 0 }).map((c) => c.id)).toEqual([
      "r-early",
      "r-late",
      "n-1",
    ]);
    expect(selectTodayCards(shifted, { ...opts, introducedLast24h: 1 }).map((c) => c.id)).toEqual([
      "r-early",
      "r-late",
    ]);
  });
});

describe("dueLabel", () => {
  const today = new Date(2026, 9, 7, 14, 0);

  it("says Due today for overdue, new and later-today cards", () => {
    expect(dueLabel(new Date(2026, 9, 3, 9, 0), today)).toBe("Due today");
    expect(dueLabel(new Date(2026, 9, 7, 14, 0), today)).toBe("Due today");
    expect(dueLabel(new Date(2026, 9, 7, 23, 30), today)).toBe("Due today");
  });

  it("shows the date for a card due after today", () => {
    const tomorrow = new Date(2026, 9, 8, 0, 5);
    expect(dueLabel(tomorrow, today)).toBe(`Due ${tomorrow.toLocaleDateString()}`);
  });
});
