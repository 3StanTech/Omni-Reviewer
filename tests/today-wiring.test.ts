import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** Every query resolves to no rows, as for a user who owns nothing. */
const selectCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/db", () => {
  const chain = () => {
    const node: Record<string, unknown> = {};
    for (const method of ["select", "from", "innerJoin", "where", "orderBy", "limit"]) node[method] = () => node;
    node.then = (resolve: (value: unknown[]) => unknown) => resolve([]);
    return node;
  };
  return {
    db: {
      select: () => {
        selectCalls.count += 1;
        return chain();
      },
    },
  };
});

import { ContentsList } from "@/components/study-side-panel";
import { PackMastery } from "@/components/reviewer-list";
import { todayHrefs } from "@/components/study-home";
import {
  getMasteryForReviewer,
  getMasteryForUser,
  getTodayPlan,
  LEGACY_SITTING_GAP_MS,
  latestSittingMisses,
  packMasterySummary,
  sectionEstimates,
  type SittingAttempt,
} from "@/lib/queries";
import type { MasteryResult, SectionMastery } from "@/lib/mastery";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 0, minute));

beforeEach(() => {
  selectCalls.count = 0;
});

describe("owner-scoped mastery and Today queries", () => {
  it("returns null mastery for a pack the user does not own, without loading its evidence", async () => {
    expect(await getMasteryForReviewer("someone-elses-pack", "user-a")).toBeNull();
    // Only the ownership lookup ran.
    expect(selectCalls.count).toBe(1);
  });

  it("returns no mastery and no Today plan when the user owns no packs", async () => {
    expect((await getMasteryForUser("user-a")).size).toBe(0);
    expect(await getTodayPlan("user-a")).toBeNull();
  });

  it("scopes every evidence query to the owner", () => {
    const queries = read("lib/queries.ts");
    const loader = queries.slice(
      queries.indexOf("async function loadPackEvidence"),
      queries.indexOf("export async function getMasteryForReviewer"),
    );
    expect(loader).toContain("eq(topics.userId, userId)");
    expect(loader).toContain("eq(testAttempts.userId, userId)");
    expect(loader).toContain("eq(cardReviews.userId, userId)");
    // One query per table for all packs, never one per pack.
    expect(loader.match(/db\s*\n?\s*\.select\(/g)?.length).toBe(4);
    expect(loader).not.toMatch(/for \(const id of reviewerIds\)[^}]*await/);
  });
});

describe("latest sitting misses", () => {
  it("keeps only the wrong answers of the newest sitting", () => {
    const attempts = [
      { itemId: "a", correct: false, attemptedAt: at(1), sessionId: "s1" },
      { itemId: "b", correct: false, attemptedAt: at(5), sessionId: "s2" },
      { itemId: "c", correct: true, attemptedAt: at(6), sessionId: "s2" },
      { itemId: "d", correct: false, attemptedAt: at(7), sessionId: "s2" },
    ];
    expect(latestSittingMisses(attempts).map((attempt) => attempt.itemId)).toEqual(["b", "d"]);
  });

  it("groups session-less attempts less than the gap apart into one sitting", () => {
    const hourLater = new Date(at(2).getTime() + LEGACY_SITTING_GAP_MS + 1);
    const attempts = [
      { itemId: "old", correct: false, attemptedAt: at(0), sessionId: null },
      { itemId: "a", correct: false, attemptedAt: hourLater, sessionId: null },
      { itemId: "b", correct: false, attemptedAt: new Date(hourLater.getTime() + 230), sessionId: null },
      { itemId: "c", correct: true, attemptedAt: new Date(hourLater.getTime() + 460), sessionId: null },
    ];
    expect(latestSittingMisses(attempts).map((attempt) => attempt.itemId)).toEqual(["a", "b"]);
    expect(latestSittingMisses([])).toEqual([]);
  });

  it("uses each item's last answer in the sitting", () => {
    const attempts = [
      { itemId: "a", correct: false, attemptedAt: at(1), sessionId: null },
      { itemId: "a", correct: true, attemptedAt: at(2), sessionId: null },
      { itemId: "b", correct: false, attemptedAt: at(3), sessionId: null },
    ];
    expect(latestSittingMisses(attempts).map((attempt) => attempt.itemId)).toEqual(["b"]);
  });
});

describe("missed per section for the Today re-test", () => {
  const lockedIn = [
    "# Antimicrobials fixture",
    "",
    "## Aminoglycosides",
    "",
    "Aminoglycosides work by a mechanism [S1 p.3]. Adverse effects [S1 p.3].",
    "",
    "## Beta-lactams",
    "",
    "Beta-lactams work by a mechanism [S1 p.5].",
  ].join("\n");
  const testItems = [
    ...["q00", "q01", "q02", "q03"].map((id) => ({ id, explanation: "Because of the slide [S1 p.3]." })),
    ...["q10", "q11", "q12", "q13"].map((id) => ({ id, explanation: "Because of the slide [S1 p.5]." })),
  ];
  const outcome: Record<string, boolean> = {
    q00: true, q01: false, q02: false, q03: false, q10: true, q11: true, q12: false, q13: false,
  };

  function estimate(attempts: SittingAttempt[]) {
    return sectionEstimates({
      input: { lockedIn, testItems, attempts, cards: [], cardReviews: [] },
      attempts,
    });
  }

  it("counts 3 missed Aminoglycosides items with no session and identical timestamps", () => {
    const attemptedAt = at(0);
    const attempts = testItems.map((item) => ({
      itemId: item.id, correct: outcome[item.id], attemptedAt, sessionId: null,
    }));
    const { missedBySection, sectionWords } = estimate(attempts);
    expect(missedBySection).toEqual({ aminoglycosides: 3, "beta-lactams": 2 });
    expect(sectionWords?.aminoglycosides).toBeGreaterThan(0);
  });

  it("counts 3 missed Aminoglycosides items when each answer was saved a moment apart", () => {
    // The browser fixture: session-less rows about 230 ms apart.
    const attempts = testItems.map((item, index) => ({
      itemId: item.id, correct: outcome[item.id], attemptedAt: new Date(at(0).getTime() + index * 230), sessionId: null,
    }));
    expect(estimate(attempts).missedBySection).toEqual({ aminoglycosides: 3, "beta-lactams": 2 });
  });
});

describe("pack row mastery summary", () => {
  const result = (weakestScore: number | null): MasteryResult => ({
    pack: { score: 0.48, items: 12 },
    sections: [],
    weakest: weakestScore === null ? null : { id: "amino", title: "Aminoglycosides", score: weakestScore },
  });

  it("names the weakest section only when it is weak", () => {
    expect(packMasterySummary(result(0.3))).toEqual({ score: 0.48, weakTitle: "Aminoglycosides" });
    expect(packMasterySummary(result(0.8))).toEqual({ score: 0.48, weakTitle: null });
    expect(packMasterySummary(result(null))).toEqual({ score: 0.48, weakTitle: null });
    expect(packMasterySummary(undefined)).toBeNull();
  });
});

describe("rows and Contents render bars from props", () => {
  it("renders Mastery N% and Weak: title in a pack row", () => {
    const html = renderToStaticMarkup(
      createElement(PackMastery, { mastery: { score: 0.48, weakTitle: "Aminoglycosides" } }),
    );
    expect(html).toContain("Mastery");
    expect(html).toContain('aria-label="Mastery 48 percent"');
    expect(html).toContain("48%");
    expect(html).toContain("Weak: Aminoglycosides");
  });

  it("renders nothing in a row without a score or weak section", () => {
    expect(renderToStaticMarkup(createElement(PackMastery, { mastery: null }))).toBe("");
    expect(
      renderToStaticMarkup(createElement(PackMastery, { mastery: { score: null, weakTitle: null } })),
    ).toBe("");
  });

  it("puts a bar by each scored section and a muted note by each unscored one", () => {
    const headings = [
      { id: "pack", text: "Pack", level: 1 },
      { id: "cells", text: "Cells", level: 2 },
      { id: "genetics", text: "Genetics", level: 2 },
    ];
    const sections: SectionMastery[] = [
      { id: "cells", title: "Cells", score: 0.75, items: 4, weak: false },
      { id: "genetics", title: "Genetics", score: null, items: 1, weak: false },
    ];
    const html = renderToStaticMarkup(createElement(ContentsList, { headings, sections }));
    const items = html.split("<li").slice(1);
    expect(items).toHaveLength(3);
    expect(items[0]).not.toContain("Mastery");
    expect(items[0]).not.toContain("Not enough answers yet");
    expect(items[1]).toContain('aria-label="Mastery 75 percent"');
    expect(items[2]).toContain("Not enough answers yet");
    expect(html).toContain('href="#user-content-cells"');
  });

  it("shows plain Contents when no mastery is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(ContentsList, { headings: [{ id: "cells", text: "Cells", level: 2 }], sections: null }),
    );
    expect(html).not.toContain("Mastery");
    expect(html).not.toContain("Not enough answers yet");
  });
});

describe("Today links", () => {
  it("opens Carded, Test Me and Locked In at the section heading", () => {
    const hrefs = todayHrefs({ p1: "t1" });
    expect(hrefs.review("p1")).toBe("/topics/t1/reviewers/p1?mode=carded");
    expect(hrefs.retest("p1")).toBe("/topics/t1/reviewers/p1?mode=test_me");
    expect(hrefs.reread("p1", "cells")).toBe("/topics/t1/reviewers/p1?mode=locked_in#user-content-cells");
  });

  it("wires the desk and pack page through the owner-scoped queries", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("getTodayPlan(userId)");
    expect(page).toContain("packMasterySummary(today?.mastery.get(r.id))");
    const packPage = read("app/topics/[topicId]/reviewers/[reviewerId]/page.tsx");
    expect(packPage).toContain("getMasteryForReviewer(reviewerId, userId)");
    expect(packPage).toContain("<SectionMasteryProvider sections={mastery?.sections ?? null}>");
  });
});

describe("touched components", () => {
  it("contain no em dashes", () => {
    for (const file of [
      "components/study-home.tsx",
      "components/reviewer-list.tsx",
      "components/topic-shelf.tsx",
      "components/study-side-panel.tsx",
      "app/page.tsx",
      "app/topics/[topicId]/reviewers/[reviewerId]/page.tsx",
    ]) {
      expect(read(file), file).not.toContain("—");
    }
  });
});
