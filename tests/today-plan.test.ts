import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PacingBlock } from "@/components/today-modal";
import type { MasteryResult } from "@/lib/mastery";
import {
  buildTodayPlan,
  dueSplitCopy,
  todayBarParts,
  todayBarSegments,
  WEAK_SECTION_DEFINITION,
  type TodayPack,
} from "@/lib/today-plan";

const now = new Date("2026-09-27T08:00:00.000Z");

function mastery(sections: { id: string; title: string; score: number | null; items?: number }[]): MasteryResult {
  return {
    pack: { score: null, items: 0 },
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      score: section.score,
      items: section.items ?? 5,
      weak: section.score !== null && section.score < 0.6,
    })),
    weakest: null,
  };
}

/** A pack whose due cards are all reviews unless the split is given. */
function pack(overrides: Partial<TodayPack> = {}): TodayPack {
  const dueToday = overrides.dueToday ?? 0;
  return {
    id: "p1",
    topicId: "t1",
    topicName: "Pharmacology 2",
    name: "Pack",
    examDate: null,
    dueToday,
    reviewDue: dueToday,
    newToday: 0,
    newRemaining: 0,
    introducedLast24h: 0,
    mastery: null,
    ...overrides,
  };
}

describe("buildTodayPlan totals and time", () => {
  it("sums due cards and counts weak sections across packs", () => {
    const plan = buildTodayPlan({
      now,
      packs: [
        pack({ id: "a", dueToday: 30, mastery: mastery([{ id: "s1", title: "One", score: 0.3 }]) }),
        pack({
          id: "b",
          dueToday: 8,
          mastery: mastery([
            { id: "s2", title: "Two", score: 0.5 },
            { id: "s3", title: "Three", score: 0.9 },
            { id: "s4", title: "Four", score: null },
          ]),
        }),
      ],
    });
    expect(plan.bar.dueCards).toBe(38);
    expect(plan.bar.weakSections).toBe(2);
    expect(plan.empty).toBe(false);
  });

  it("splits due cards into to review and new, summing to dueCards", () => {
    const plan = buildTodayPlan({
      now,
      packs: [
        pack({ id: "a", dueToday: 25, reviewDue: 5, newToday: 20 }),
        pack({ id: "b", dueToday: 7, reviewDue: 7, newToday: 0 }),
      ],
    });
    expect(plan.bar).toMatchObject({ dueCards: 32, reviewCards: 12, newCards: 20 });
    expect(plan.bar.reviewCards + plan.bar.newCards).toBe(plan.bar.dueCards);
    expect(todayBarSegments(plan.bar).slice(0, 2)).toEqual(["12 to review", "20 new"]);
  });

  it("estimates 8 s per card, 45 s per re-test question and words / 200 per re-read, rounded to 5 min", () => {
    // 100 cards = 800 s. Re-test: missed 8 = 360 s. Re-read: 1150 words = 6 min = 360 s. 1520 s = 25.3 min -> 25.
    const plan = buildTodayPlan({
      now,
      packs: [
        pack({
          dueToday: 100,
          mastery: mastery([{ id: "s1", title: "Weak", score: 0.2 }]),
          missedBySection: { s1: 8 },
          sectionWords: { s1: 1150 },
        }),
      ],
    });
    expect(plan.doFirst.find((item) => item.kind === "reread")).toMatchObject({ minutes: 6 });
    expect(plan.bar.minutes).toBe(25);
  });

  it("rounds to the nearest 5 minutes and never below 5 when there is work", () => {
    const one = buildTodayPlan({ now, packs: [pack({ dueToday: 1 })] });
    expect(one.bar.minutes).toBe(5);
    // 200 cards = 1600 s = 26.7 min -> 25; 230 cards = 1840 s = 30.7 min -> 30.
    expect(buildTodayPlan({ now, packs: [pack({ dueToday: 200 })] }).bar.minutes).toBe(25);
    expect(buildTodayPlan({ now, packs: [pack({ dueToday: 230 })] }).bar.minutes).toBe(30);
  });

  it("charges at least 5 questions for a re-test with fewer misses", () => {
    // 5 x 45 s = 225 s, plus 1 min re-read = 285 s = 4.75 min -> 5.
    const plan = buildTodayPlan({
      now,
      packs: [pack({ mastery: mastery([{ id: "s1", title: "Weak", score: 0.1 }]), missedBySection: { s1: 1 } })],
    });
    expect(plan.bar.minutes).toBe(5);
    expect(plan.doFirst[0]).toMatchObject({ kind: "retest", missed: 1 });
  });
});

describe("todayBarSegments", () => {
  it("omits zero and null segments and joins in order", () => {
    expect(
      todayBarSegments({ dueCards: 32, reviewCards: 12, newCards: 20, weakSections: 3, exam: { topicName: "Pharm", days: 9 }, minutes: 20 }),
    ).toEqual(["12 to review", "20 new", "3 weak sections", "Pharm exam in 9 days", "About 20 min"]);
    expect(todayBarSegments({ dueCards: 38, reviewCards: 38, newCards: 0, weakSections: 2, exam: { topicName: "Pharm", days: 9 }, minutes: 35 })).toEqual([
      "38 to review",
      "2 weak sections",
      "Pharm exam in 9 days",
      "About 35 min",
    ]);
    expect(todayBarSegments({ dueCards: 0, reviewCards: 0, newCards: 0, weakSections: 1, exam: null, minutes: 5 })).toEqual([
      "1 weak section",
      "About 5 min",
    ]);
    expect(todayBarSegments({ dueCards: 1, reviewCards: 0, newCards: 1, weakSections: 0, exam: { topicName: "Pharm", days: 1 }, minutes: 0 })).toEqual([
      "1 new",
      "Pharm exam in 1 day",
    ]);
    expect(todayBarSegments({ dueCards: 0, reviewCards: 0, newCards: 0, weakSections: 0, exam: null, minutes: 0 })).toEqual([]);
  });

  it("flags only the weak part for its definition", () => {
    const parts = todayBarParts({ dueCards: 2, reviewCards: 2, newCards: 0, weakSections: 1, exam: null, minutes: 5 });
    expect(parts.filter((part) => part.weak).map((part) => part.text)).toEqual(["1 weak section"]);
    expect(WEAK_SECTION_DEFINITION).toBe("Under 60% correct on 3 or more answers");
  });
});

describe("dueSplitCopy", () => {
  it("omits zero parts and is empty when both are zero", () => {
    expect(dueSplitCopy(2, 5)).toBe("2 to review · 5 new");
    expect(dueSplitCopy(0, 5)).toBe("5 new");
    expect(dueSplitCopy(3, 0)).toBe("3 to review");
    expect(dueSplitCopy(0, 0)).toBe("");
  });
});

describe("Do first", () => {
  const packs = [
    pack({
      id: "a",
      dueToday: 10,
      mastery: mastery([
        { id: "a1", title: "A1", score: 0.55 },
        { id: "a2", title: "A2", score: 0.2 },
      ]),
    }),
    pack({
      id: "b",
      dueToday: 25,
      mastery: mastery([
        { id: "b1", title: "B1", score: 0.4 },
        { id: "b2", title: "B2", score: 0.3 },
        { id: "b3", title: "B3", score: 0.6 },
      ]),
    }),
    pack({ id: "c", dueToday: 0 }),
  ];

  it("orders review, up to 2 re-tests (weakest first across packs), then 1 re-read of the weakest section not already re-tested", () => {
    const plan = buildTodayPlan({ now, packs });
    expect(plan.doFirst.map((item) => item.kind)).toEqual(["review", "retest", "retest", "reread"]);
    expect(plan.doFirst[0]).toEqual({ kind: "review", dueCards: 35, packCount: 2, packId: "b" });
    expect(plan.doFirst[1]).toMatchObject({ kind: "retest", packId: "a", sectionId: "a2", score: 0.2 });
    expect(plan.doFirst[2]).toMatchObject({ kind: "retest", packId: "b", sectionId: "b2", score: 0.3 });
    expect(plan.doFirst[3]).toMatchObject({ kind: "reread", packId: "b", sectionId: "b1", title: "B1", score: 0.4 });
    expect(plan.bar.weakSections).toBe(4);
  });

  it("re-reads the weakest overall when every weak section is already a re-test", () => {
    const plan = buildTodayPlan({
      now,
      packs: [
        pack({
          mastery: mastery([
            { id: "s1", title: "S1", score: 0.4 },
            { id: "s2", title: "S2", score: 0.2 },
          ]),
        }),
      ],
    });
    expect(plan.doFirst.map((item) => item.kind)).toEqual(["retest", "retest", "reread"]);
    expect(plan.doFirst[2]).toMatchObject({ kind: "reread", sectionId: "s2", score: 0.2 });
  });

  it("treats exactly 60 percent as not weak", () => {
    const plan = buildTodayPlan({ now, packs: [pack({ mastery: mastery([{ id: "s", title: "S", score: 0.6 }]) })] });
    expect(plan.bar.weakSections).toBe(0);
    expect(plan.doFirst).toEqual([]);
  });

  it("omits the review row when nothing is due", () => {
    const plan = buildTodayPlan({ now, packs: [pack({ mastery: mastery([{ id: "s", title: "S", score: 0.1 }]) })] });
    expect(plan.doFirst.map((item) => item.kind)).toEqual(["retest", "reread"]);
  });
});

describe("empty state", () => {
  it("is empty with no due cards and no weak sections", () => {
    const plan = buildTodayPlan({
      now,
      packs: [pack({ mastery: mastery([{ id: "s", title: "S", score: 0.9 }]), newRemaining: 12 })],
    });
    expect(plan.empty).toBe(true);
    expect(plan.bar.minutes).toBe(0);
    expect(plan.doFirst).toEqual([]);
  });

  it("is empty with no packs", () => {
    expect(buildTodayPlan({ now, packs: [] }).empty).toBe(true);
  });
});

describe("nearest exam", () => {
  it("picks the nearest upcoming exam across packs and ignores passed dates", () => {
    const plan = buildTodayPlan({
      now,
      packs: [
        pack({ topicName: "Far", examDate: "2026-11-01" }),
        pack({ id: "p2", topicId: "t2", topicName: "Near", examDate: "2026-10-06" }),
        pack({ id: "p3", topicId: "t3", topicName: "Gone", examDate: "2026-09-01" }),
        pack({ id: "p4", topicId: "t4", topicName: "None" }),
      ],
    });
    expect(plan.bar.exam).toEqual({ topicName: "Near", days: 9 });
    expect(plan.pacing.map((group) => group.topicName)).toEqual(["Near", "Far"]);
  });

  it("is null without an upcoming exam", () => {
    const plan = buildTodayPlan({ now, packs: [pack({ examDate: "2026-09-01" }), pack({ id: "p2" })] });
    expect(plan.bar.exam).toBeNull();
    expect(plan.pacing).toEqual([]);
  });

  it("counts an exam today as 0 days", () => {
    expect(buildTodayPlan({ now, packs: [pack({ examDate: "2026-09-27" })] }).bar.exam?.days).toBe(0);
  });
});

describe("exam pacing strip", () => {
  it("runs from today to the exam day for a short exam", () => {
    const plan = buildTodayPlan({ now, packs: [pack({ examDate: "2026-10-03", newRemaining: 12 })] });
    const [group] = plan.pacing;
    expect(group.days).toBe(6);
    expect(group.strip).toHaveLength(7);
    expect(group.strip[0].date).toBe("2026-09-27");
    expect(group.strip[6].date).toBe("2026-10-03");
  });

  it("shows today, the next 6 days and the exam day for a long exam", () => {
    const plan = buildTodayPlan({ now, packs: [pack({ examDate: "2026-11-15", newRemaining: 40 })] });
    const [group] = plan.pacing;
    expect(group.strip).toHaveLength(8);
    expect(group.strip.map((day) => day.date)).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-11-15",
    ]);
  });

  it("keeps every column up to 14 days", () => {
    // 13 days out is 14 columns; 14 days out is 15, so it condenses.
    expect(buildTodayPlan({ now, packs: [pack({ examDate: "2026-10-10" })] }).pacing[0].strip).toHaveLength(14);
    expect(buildTodayPlan({ now, packs: [pack({ examDate: "2026-10-11" })] }).pacing[0].strip).toHaveLength(8);
  });

  it("spreads new cards by newCardAllowance and holds the last 2 days back", () => {
    // The exam is 5 whole days away, so 3 spread days: ceil(12 / 3) = 4 a day, then the last 2 days are held back.
    const [group] = buildTodayPlan({ now, packs: [pack({ examDate: "2026-10-03", newRemaining: 12 })] }).pacing;
    expect(group.strip.map((day) => day.newCards)).toEqual([4, 4, 4, 0, 0, 0, 0]);
  });

  it("subtracts what was already introduced in the last 24 hours from today only", () => {
    const [group] = buildTodayPlan({
      now,
      packs: [pack({ examDate: "2026-10-03", newRemaining: 12, introducedLast24h: 3 })],
    }).pacing;
    // Today: 4 a day minus 3 already introduced = 1. Later days start with an empty window; every card is still placed.
    expect(group.strip[0].newCards).toBe(1);
    expect(group.strip.reduce((sum, day) => sum + day.newCards, 0)).toBe(12);
  });

  it("sums packs of one topic and exam, and counts them", () => {
    const [group] = buildTodayPlan({
      now,
      packs: [
        pack({ id: "a", examDate: "2026-10-03", newRemaining: 12 }),
        pack({ id: "b", examDate: "2026-10-03", newRemaining: 8 }),
        pack({ id: "c", examDate: "2026-10-10", newRemaining: 8 }),
      ],
    }).pacing;
    expect(group.packCount).toBe(2);
    expect(group.strip[0].newCards).toBe(7); // ceil(12 / 3) + ceil(8 / 3)
  });

  it("gives packs with different exams in one topic their own rows", () => {
    const plan = buildTodayPlan({
      now,
      packs: [
        pack({ id: "a", examDate: "2026-10-03" }),
        pack({ id: "b", examDate: "2026-10-10" }),
      ],
    });
    expect(plan.pacing.map((group) => group.examDate)).toEqual(["2026-10-03", "2026-10-10"]);
  });
});

describe("today components", () => {
  it("contain no em dashes", () => {
    for (const file of ["mastery-bar", "today-card", "today-modal", "study-help"]) {
      const source = readFileSync(`components/${file}.tsx`, "utf8");
      expect(source.includes("—"), `${file}.tsx`).toBe(false);
    }
    expect(readFileSync("lib/today-plan.ts", "utf8").includes("—")).toBe(false);
  });
});

describe("pacing strip layout", () => {
  it("lets only the strip scroll: wrapper and strip carry the min-width guard", () => {
    const [group] = buildTodayPlan({ now, packs: [pack({ examDate: "2026-11-15", newRemaining: 40 })] }).pacing;
    const html = renderToStaticMarkup(createElement(PacingBlock, { group }));
    expect(html).toMatch(/^<div class="[^"]*\bmin-w-0\b/);
    expect(html).toMatch(/<ol class="[^"]*\bmin-w-0\b[^"]*\boverflow-x-auto\b/);
    const source = readFileSync("components/today-modal.tsx", "utf8");
    expect(source).toContain("grid-cols-[minmax(0,1fr)]");
  });
});
