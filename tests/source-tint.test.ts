import { describe, expect, it } from "vitest";

import {
  bestScoredPage,
  itemsInSpan,
  joinTextItems,
  lastSentence,
  multiplyTransform,
  rangeTintPages,
  textItemBox,
} from "@/lib/passage-tint";

describe("lastSentence", () => {
  it("keeps the second of two sentences", () => {
    expect(lastSentence("Insulin lowers glucose. Glucagon raises it ")).toBe("Glucagon raises it");
  });

  it("does not split at abbreviations", () => {
    expect(lastSentence("Beta blockers, e.g. propranolol, slow the heart ")).toBe("Beta blockers, e.g. propranolol, slow the heart");
    expect(lastSentence("See Fig. 3 for the loop")).toBe("See Fig. 3 for the loop");
  });

  it("keeps a trailing sentence end and splits on ! and ?", () => {
    expect(lastSentence("Is it renal? It is hepatic. ")).toBe("It is hepatic.");
    expect(lastSentence("Watch out! Dose by weight")).toBe("Dose by weight");
  });

  it("collapses whitespace from table cells and line breaks", () => {
    expect(lastSentence("Drug \n  Dose\tAdults only")).toBe("Drug Dose Adults only");
  });

  it("returns null for empty text", () => {
    expect(lastSentence("")).toBeNull();
    expect(lastSentence("   \n ")).toBeNull();
  });
});

describe("joinTextItems and itemsInSpan", () => {
  const items = [
    { str: "Loop diuretics" },
    { str: "act on", hasEOL: true },
    { str: "the thick" },
    { str: "ascending limb." },
  ];

  it("joins with spaces and line ends and records each item's offsets", () => {
    const joined = joinTextItems(items);
    expect(joined.text).toBe("Loop diuretics act on\nthe thick ascending limb. ");
    expect(joined.ranges).toEqual([
      { start: 0, end: 14 },
      { start: 15, end: 21 },
      { start: 22, end: 31 },
      { start: 32, end: 47 },
    ]);
  });

  it("returns the items overlapping a span, including partial ones", () => {
    const { text, ranges } = joinTextItems(items);
    const start = text.indexOf("on");
    const end = text.indexOf("thick") + 2;
    expect(itemsInSpan(ranges, { start, end })).toEqual([1, 2]);
    expect(itemsInSpan(ranges, { start: 0, end: text.length })).toEqual([0, 1, 2, 3]);
  });

  it("skips empty items and spans that touch only an edge", () => {
    const { ranges } = joinTextItems([{ str: "A" }, { str: "" }, { str: "B" }]);
    expect(itemsInSpan(ranges, { start: 0, end: 4 })).toEqual([0, 2]);
    expect(itemsInSpan(ranges, { start: 1, end: 4 })).toEqual([2]);
    expect(itemsInSpan(ranges, { start: 1, end: 3 })).toEqual([]);
  });
});

describe("textItemBox", () => {
  it("matches PDF.js Util.transform and sizes from font height and width", () => {
    // A 612x792 page at scale 2: y flips and grows down.
    const viewport = [2, 0, 0, -2, 0, 1584];
    expect(multiplyTransform(viewport, [12, 0, 0, 12, 72, 700])).toEqual([24, 0, 0, -24, 144, 184]);
    expect(textItemBox(viewport, 2, { str: "x", transform: [12, 0, 0, 12, 72, 700], width: 50 })).toEqual({
      left: 144,
      top: 160,
      width: 100,
      height: 24,
    });
  });

  it("returns null without a transform or width", () => {
    expect(textItemBox([1, 0, 0, -1, 0, 100], 1, { str: "x" })).toBeNull();
    expect(textItemBox([1, 0, 0, -1, 0, 100], 1, { str: "", transform: [10, 0, 0, 10, 0, 0], width: 0 })).toBeNull();
  });
});

describe("range pages", () => {
  it("scores up to 4 pages of a range", () => {
    expect(rangeTintPages(3, null)).toEqual([3]);
    expect(rangeTintPages(3, 3)).toEqual([3]);
    expect(rangeTintPages(3, 5)).toEqual([3, 4, 5]);
    expect(rangeTintPages(3, 20)).toEqual([3, 4, 5, 6]);
  });

  it("opens the best page, first on ties, null when none scored", () => {
    expect(bestScoredPage([{ page: 3, score: 0.4 }, { page: 4, score: 0.7 }, { page: 5, score: null }])).toBe(4);
    expect(bestScoredPage([{ page: 3, score: 0.5 }, { page: 4, score: 0.5 }])).toBe(3);
    expect(bestScoredPage([{ page: 3, score: null }, { page: 4, score: null }])).toBeNull();
  });
});
