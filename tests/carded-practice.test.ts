import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { practiceQueue } from "@/lib/practice-session";

const root = path.resolve(__dirname, "..");
const src = readFileSync(path.join(root, "components/carded-view.tsx"), "utf8");

/** The source of one function in carded-view, up to the next top-level helper. */
function fnBody(start: string, end: string) {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe("practiceQueue", () => {
  const queue = [
    { id: "a", revision: 1 },
    { id: "b", revision: 2 },
    { id: "c", revision: 1 },
  ];

  it("returns every captured card in session order for all", () => {
    expect(practiceQueue({ queue, againIds: ["c"], which: "all" })).toEqual(queue);
  });

  it("returns only Again cards, in session order, for missed", () => {
    expect(practiceQueue({ queue, againIds: ["c", "a"], which: "missed" })).toEqual([
      { id: "a", revision: 1 },
      { id: "c", revision: 1 },
    ]);
    expect(practiceQueue({ queue, againIds: [], which: "missed" })).toEqual([]);
  });

  it("ignores Again ids outside the queue and does not mutate it", () => {
    const result = practiceQueue({ queue, againIds: ["zz"], which: "all" });
    expect(result).not.toBe(queue);
    expect(practiceQueue({ queue, againIds: ["zz"], which: "missed" })).toEqual([]);
  });
});

describe("Carded practice", () => {
  it("removes Restart", () => {
    expect(src).not.toContain("Restart");
    expect(src).not.toContain("ArrowCounterClockwise");
  });

  it("offers Practice missed only when there are misses, and Practice all, on the session recap", () => {
    const buttons = fnBody("function practiceButtons(", "if (packEmpty)");
    expect(buttons).toContain("{missed.length > 0 ? (");
    expect(buttons).toContain("Practice missed ({missed.length})");
    expect(buttons).toContain("Practice all ({all.length})");
    expect(buttons).toContain('which: "missed"');
    expect(buttons).toContain('which: "all"');
    expect(src).toContain("{practiceButtons(queue, againIds)}");
  });

  it("ends practice on Practice done with the same buttons plus Back to due", () => {
    expect(src).toContain('title="Practice done"');
    expect(src).toContain("{practiceButtons(practiceCaptured, practiceAgainIds, true)}");
    expect(fnBody("function practiceButtons(", "if (packEmpty)")).toContain("Back to due");
  });

  it("never POSTs a review or changes a card while practicing", () => {
    const rate = fnBody("function practiceRate(", "async function review(");
    expect(rate).not.toContain("fetch(");
    expect(rate).not.toContain("/review");
    expect(rate).not.toContain("onCardsChange");
    const enter = fnBody("function enterPractice(", "function practiceRate(");
    expect(enter).not.toContain("fetch(");
    expect(fnBody("async function review(", "useEffect(")).toMatch(/\/\/ Practice never saves a rating\.\s*if \(practicing\) return;/);
    // Edit and Pin change the card, so they are not offered in practice.
    expect(src.match(/isDurableCard\(card\) && !practicing \? <button/g)).toHaveLength(2);
  });

  it("labels the header and keeps Browse all and Study due", () => {
    expect(src).toContain("Practice, not scheduled");
    expect(src).toContain("Browse all");
    expect(src).toContain("Study due");
    expect(src).toContain("{browsing || practicing ? (");
  });

  it("keeps 1/2 and Space in practice, routed to the local rating", () => {
    const keys = fnBody("function onKeyDown(event: KeyboardEvent)", 'window.addEventListener("keydown", onKeyDown)');
    expect(keys).toContain("toggleFlip();");
    expect(keys).toMatch(/if \(practicing\) \{\s*if \(event\.key === "1"\) practiceRate\("again"\);\s*if \(event\.key === "2"\) practiceRate\("good"\);\s*return;\s*\}/);
    expect(src).toContain("[browsing, practicing, browseCards.length, busy, card, dueStale, editing, flipped, scheduleHint]");
  });

  it("shows plain Again and Good in practice, without schedule previews", () => {
    expect(src).toContain('onClick={() => practiceRate("again")}');
    expect(src).toContain('onClick={() => practiceRate("good")}');
  });

  it("shows the remaining split in due mode", () => {
    expect(src).toContain("<p>Remaining: {remainingCopy}</p>");
    expect(src).toContain('dueSplitCopy(remaining.review, remaining.fresh) || "none"');
    expect(src).toContain("const fresh = due.filter((item) => item.isNew).length;");
  });
});
