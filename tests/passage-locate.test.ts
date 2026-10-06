import { describe, expect, it } from "vitest";
import { locatePassage, PASSAGE_TINT_MIN_SCORE } from "@/lib/passage-locate";

const FILLER = [
  "The library opens at nine in the morning and closes after the evening lectures end.",
  "Students may borrow up to five books at a time from the general collection shelves.",
  "Quiet study rooms on the third floor can be reserved through the front desk counter.",
  "Printing services are available near the entrance for a small fee per printed sheet.",
  "Late returns are charged a modest daily fine until the borrowed item is brought back.",
  "Group projects often meet in the commons area, which has large tables and whiteboards.",
];

const TARGET = "Mitochondria produce adenosine triphosphate through oxidative phosphorylation across the inner membrane.";

const PAGE = [...FILLER.slice(0, 3), TARGET, ...FILLER.slice(3)].join(" ");

describe("locatePassage", () => {
  it("locates an exact sentence inside a long page", () => {
    const located = locatePassage(TARGET, PAGE);
    expect(located).not.toBeNull();
    const span = PAGE.slice(located!.start, located!.end);
    expect(span).toContain(TARGET);
    expect(located!.score).toBeGreaterThanOrEqual(PASSAGE_TINT_MIN_SCORE);
  });

  it("locates a paraphrase", () => {
    const located = locatePassage(
      "Through oxidative phosphorylation, the mitochondria generate adenosine triphosphate.",
      PAGE,
    );
    expect(located).not.toBeNull();
    expect(PAGE.slice(located!.start, located!.end)).toContain("oxidative phosphorylation");
  });

  it("returns null for an unrelated claim", () => {
    expect(locatePassage("Photosynthesis converts carbon dioxide into glucose inside chloroplasts.", PAGE)).toBeNull();
  });

  it("returns null for an empty claim or text", () => {
    expect(locatePassage("", PAGE)).toBeNull();
    expect(locatePassage("[S1 p.2]", PAGE)).toBeNull();
    expect(locatePassage(TARGET, "  ")).toBeNull();
  });

  it("ignores citations and unsourced marks in the claim", () => {
    const plain = locatePassage(TARGET, PAGE);
    const cited = locatePassage(`${TARGET} [S1 p.4] [[unsourced]]`, PAGE);
    expect(cited).toEqual(plain);
  });

  it("starts and ends the span on sentence boundaries when available", () => {
    const located = locatePassage(TARGET, PAGE)!;
    const span = PAGE.slice(located.start, located.end);
    expect(located.start === 0 || /[.!?]\s$/.test(PAGE.slice(0, located.start))).toBe(true);
    expect(span).toMatch(/[.!?]$/);
    expect(span).toBe(span.trim());
  });

  it("ends a span at a line break inside the window", () => {
    const text = `${FILLER[0]}\n${TARGET}\n${FILLER[1]}\n${FILLER[2]}`;
    const located = locatePassage(TARGET, text)!;
    expect(text.slice(located.start, located.end)).not.toContain("\n\n");
    expect(text.slice(located.start, located.end)).toContain("oxidative phosphorylation");
  });

  it("handles a page shorter than the minimum window", () => {
    const text = "Mitochondria produce ATP.";
    const located = locatePassage("Mitochondria produce ATP [S1 p.1].", text);
    expect(located).toEqual({ start: 0, end: text.length, score: expect.any(Number) });
  });

  it("honours a custom minScore", () => {
    const claim = "Mitochondria produce adenosine triphosphate inside chloroplasts during photosynthesis.";
    const located = locatePassage(claim, PAGE, { minScore: 0 });
    expect(located).not.toBeNull();
    expect(locatePassage(claim, PAGE, { minScore: located!.score + 0.01 })).toBeNull();
    expect(locatePassage(TARGET, PAGE, { minScore: 1.01 })).toBeNull();
  });
});
