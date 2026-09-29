import { describe, expect, it } from "vitest";

import {
  MASTERY_MIN_ITEMS,
  MASTERY_WEAK_THRESHOLD,
  citedPages,
  computeMastery,
  sectionsFromLockedIn,
  type MasteryInput,
} from "@/lib/mastery";
import { studyOutline } from "@/lib/study-outline";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 0, minute));

const LOCKED_IN = [
  "# Pack",
  "",
  "## Cells",
  "Cells are the unit of life. [S1 p.1]",
  "Membranes matter. [S1 pp.2-3]",
  "",
  "### Organelles",
  "Mitochondria make energy. [S1 p.4]",
  "",
  "## Genetics",
  "Genes encode proteins. [S2]",
  "",
  "## Cells",
  "More about cells. [S1 p.9]",
].join("\n");

function input(overrides: Partial<MasteryInput>): MasteryInput {
  return { lockedIn: LOCKED_IN, testItems: [], attempts: [], cards: [], cardReviews: [], ...overrides };
}

/** n Test Me items citing `cite`, all attempted with the given outcome. */
function items(prefix: string, cite: string, n: number, correct: boolean) {
  const testItems = Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, explanation: `Because. ${cite}` }));
  const attempts = testItems.map((item) => ({ itemId: item.id, correct, attemptedAt: at(1) }));
  return { testItems, attempts };
}

describe("citedPages", () => {
  it("maps a page, a range, a comma list and a bare source", () => {
    expect(citedPages("A [S1 p.14]. B [S1 pp.14-16]. C [S2]. D [S3 p.2, p.5]")).toEqual(
      new Set(["S1:14", "S1:15", "S1:16", "S2:*", "S3:2", "S3:5"]),
    );
  });

  it("is empty without citations", () => {
    expect(citedPages("no citations [[unsourced]]").size).toBe(0);
  });
});

describe("sectionsFromLockedIn", () => {
  it("uses ## sections with nested content, pages and citation-free words", () => {
    const sections = sectionsFromLockedIn(LOCKED_IN);
    expect(sections.map((s) => s.title)).toEqual(["Cells", "Genetics", "Cells"]);
    expect(sections[0].level).toBe(2);
    expect(sections[0].pages).toEqual(new Set(["S1:1", "S1:2", "S1:3", "S1:4"]));
    expect(sections[1].pages).toEqual(new Set(["S2:*"]));
    // "Cells are the unit of life." (6) + "Membranes matter." (2) + "Organelles" (1) + "Mitochondria make energy." (3)
    expect(sections[0].words).toBe(12);
    expect(sections[1].words).toBe(3);
  });

  it("uses the same ids as the study outline, including duplicates", () => {
    const ids = sectionsFromLockedIn(LOCKED_IN).map((s) => s.id);
    expect(ids).toEqual(["cells", "genetics", "cells-2"]);
    const outline = studyOutline(LOCKED_IN);
    for (const section of sectionsFromLockedIn(LOCKED_IN)) {
      expect(outline.find((heading) => heading.id === section.id)?.text).toBe(section.title);
    }
  });

  it("falls back to # or ### when fewer than 2 ## exist", () => {
    const h1 = "# One\nA [S1 p.1]\n# Two\nB [S1 p.2]\n## Only\nC [S1 p.3]";
    expect(sectionsFromLockedIn(h1).map((s) => s.id)).toEqual(["one", "two"]);
    expect(sectionsFromLockedIn(h1)[1].pages).toEqual(new Set(["S1:2", "S1:3"]));
    const h3 = "## Solo\n### A\nx [S1 p.1]\n### B\ny [S1 p.2]";
    expect(sectionsFromLockedIn(h3).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("returns nothing without two headings at any usable level", () => {
    expect(sectionsFromLockedIn("")).toEqual([]);
    expect(sectionsFromLockedIn("just text [S1 p.1]")).toEqual([]);
    expect(sectionsFromLockedIn("## Only one\ntext")).toEqual([]);
    expect(sectionsFromLockedIn("# A\n## B\n### C")).toEqual([]);
  });
});

describe("computeMastery", () => {
  it("exports the contract constants", () => {
    expect(MASTERY_WEAK_THRESHOLD).toBe(0.6);
    expect(MASTERY_MIN_ITEMS).toBe(3);
  });

  it("matches a page item to sections with that page, a range page, or the whole source", () => {
    const result = computeMastery(
      input({
        lockedIn: "## A\nx [S1 pp.2-3]\n## B\ny [S1]\n## C\nz [S1 p.9]\n## D\nw [S2 p.1]",
        ...items("q", "[S1 p.3]", 3, true),
      }),
    );
    expect(result.sections.map((s) => [s.id, s.items])).toEqual([["a", 3], ["b", 3], ["c", 0], ["d", 0]]);
  });

  it("matches a bare-source item to any page of that source only", () => {
    const result = computeMastery(
      input({ lockedIn: "## A\nx [S2 p.7]\n## B\ny [S1 p.1]", ...items("q", "[S2]", 3, true) }),
    );
    expect(result.sections.map((s) => s.items)).toEqual([3, 0]);
  });

  it("maps an item to every section sharing a page", () => {
    const result = computeMastery(
      input({ lockedIn: "## A\nx [S1 p.5]\n## B\ny [S1 pp.4-6]", ...items("q", "[S1 p.5]", 3, false) }),
    );
    expect(result.sections.map((s) => s.items)).toEqual([3, 3]);
    expect(result.pack.items).toBe(3);
  });

  it("uses only the latest attempt per item", () => {
    const { testItems } = items("q", "[S1 p.1]", 3, true);
    const attempts = [
      ...testItems.map((item) => ({ itemId: item.id, correct: false, attemptedAt: at(1) })),
      ...testItems.map((item) => ({ itemId: item.id, correct: true, attemptedAt: at(5) })),
      { itemId: "q0", correct: false, attemptedAt: at(0) },
    ];
    const result = computeMastery(input({ lockedIn: "## A\nx [S1 p.1]\n## B\ny", testItems, attempts }));
    expect(result.sections[0]).toMatchObject({ items: 3, score: 1 });
    expect(result.pack).toEqual({ score: 1, items: 3 });
  });

  it("ignores attempts for items no longer in Test Me", () => {
    const current = items("q", "[S1 p.1]", 3, true);
    const stale = { itemId: "gone", correct: false, attemptedAt: at(9) };
    const result = computeMastery(
      input({ lockedIn: "## A\nx [S1 p.1]\n## B\ny", testItems: current.testItems, attempts: [...current.attempts, stale] }),
    );
    expect(result.pack.items).toBe(3);
    expect(result.sections[0].score).toBe(1);
  });

  it("ignores unreviewed and archived cards, and uses the latest review", () => {
    const cards = [
      { id: "c1", back: "[S1 p.1]", archivedAt: null },
      { id: "c2", back: "[S1 p.1]", archivedAt: null },
      { id: "c3", back: "[S1 p.1]", archivedAt: null },
      { id: "unreviewed", back: "[S1 p.1]", archivedAt: null },
      { id: "archived", back: "[S1 p.1]", archivedAt: at(2) },
    ];
    const cardReviews = [
      { cardId: "c1", rating: "again" as const, reviewedAt: at(1) },
      { cardId: "c1", rating: "good" as const, reviewedAt: at(2) },
      { cardId: "c2", rating: "good" as const, reviewedAt: at(1) },
      { cardId: "c3", rating: "again" as const, reviewedAt: at(1) },
      { cardId: "archived", rating: "again" as const, reviewedAt: at(1) },
    ];
    const result = computeMastery(input({ lockedIn: "## A\nx [S1 p.1]\n## B\ny", cards, cardReviews }));
    expect(result.pack.items).toBe(3);
    expect(result.sections[0].items).toBe(3);
    expect(result.sections[0].score).toBeCloseTo(2 / 3);
  });

  it("gives null with fewer than 3 items", () => {
    const result = computeMastery(input({ lockedIn: "## A\nx [S1 p.1]\n## B\ny", ...items("q", "[S1 p.1]", 2, false) }));
    expect(result.sections[0]).toMatchObject({ score: null, items: 2, weak: false });
    expect(result.weakest).toBeNull();
    expect(result.pack).toEqual({ score: 0, items: 2 });
  });

  it("marks a section weak only under 60%", () => {
    const build = (correct: number) => {
      const testItems = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, explanation: "[S1 p.1]" }));
      const attempts = testItems.map((item, i) => ({ itemId: item.id, correct: i < correct, attemptedAt: at(1) }));
      return computeMastery(input({ lockedIn: "## A\nx [S1 p.1]\n## B\ny", testItems, attempts })).sections[0];
    };
    expect(build(2)).toMatchObject({ score: 0.4, weak: true });
    expect(build(3)).toMatchObject({ score: 0.6, weak: false });
  });

  it("picks the lowest score as weakest and breaks ties by most items", () => {
    const lockedIn = "## A\nx [S1 p.1]\n## B\ny [S2 p.1]\n## C\nz [S3 p.1]";
    const a = items("a", "[S1 p.1]", 3, false);
    const b = items("b", "[S2 p.1]", 4, false);
    const c = items("c", "[S3 p.1]", 5, true);
    const result = computeMastery(
      input({
        lockedIn,
        testItems: [...a.testItems, ...b.testItems, ...c.testItems],
        attempts: [...a.attempts, ...b.attempts, ...c.attempts],
      }),
    );
    expect(result.weakest).toEqual({ id: "b", title: "B", score: 0 });
  });

  it("computes pack mastery over all unique evidence, including unmatched items", () => {
    const matched = items("m", "[S1 p.1]", 3, true);
    const orphan = { id: "o", explanation: "no citation" };
    const cards = [{ id: "c", back: "[S9 p.1]", archivedAt: null }];
    const result = computeMastery(
      input({
        lockedIn: "## A\nx [S1 p.1]\n## B\ny",
        testItems: [...matched.testItems, orphan],
        attempts: [...matched.attempts, { itemId: "o", correct: false, attemptedAt: at(1) }],
        cards,
        cardReviews: [{ cardId: "c", rating: "again", reviewedAt: at(1) }],
      }),
    );
    expect(result.pack).toEqual({ score: 3 / 5, items: 5 });
    expect(result.sections[0].items).toBe(3);
  });

  it("has an empty pack and no sections without evidence or Locked In", () => {
    expect(computeMastery(input({ lockedIn: null }))).toEqual({
      pack: { score: null, items: 0 },
      sections: [],
      weakest: null,
    });
  });

  it("scores against # sections when there is no ##", () => {
    const result = computeMastery(
      input({ lockedIn: "# A\nx [S1 p.1]\n# B\ny", ...items("q", "[S1 p.1]", 3, true) }),
    );
    expect(result.sections.map((s) => s.id)).toEqual(["a", "b"]);
    expect(result.sections[0].score).toBe(1);
  });
});
