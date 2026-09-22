import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const EM_DASH = "\u2014";

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("Carded recall flip", () => {
  const src = read("components/carded-view.tsx");

  it("uses an end-over-end rotateX flip with preserve-3d and about 700ms", () => {
    expect(src).toContain("rotateX(180deg)");
    expect(src).toContain("preserve-3d");
    expect(src).toContain("700ms");
    expect(src).toContain("transform-style: preserve-3d");
    expect(src).not.toContain("rotateY(");
  });

  it("flips on click, Enter, and Space", () => {
    expect(src).toContain("onClick={toggleFlip}");
    expect(src).toContain('event.key === "Enter" || event.key === " "');
    expect(src).toContain("toggleFlip()");
  });

  it("keeps Again and Good out of the tree until the card is flipped", () => {
    expect(src).toContain("isDurableCard(card) && flipped");
    const gradesBlock = src.slice(src.indexOf("isDurableCard(card) && flipped"));
    expect(gradesBlock).toContain(">Again<");
    expect(gradesBlock).toContain(">Good<");
    const beforeGrades = src.slice(0, src.indexOf("isDurableCard(card) && flipped"));
    expect(beforeGrades).not.toContain(">Again<");
    expect(beforeGrades).not.toContain(">Good<");
  });

  it("does not use emoji grade buttons", () => {
    expect(src).not.toMatch(/Again[\s\S]{0,80}[\u{1F300}-\u{1FAFF}]/u);
    expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}][\s\S]{0,80}Good/u);
    expect(src).not.toContain("👍");
    expect(src).not.toContain("👎");
    expect(src).not.toContain("😀");
    expect(src).not.toContain("😊");
  });

  it("shows memorize chrome and remaining due, not a quiz score", () => {
    expect(src).toContain("Memorize. No choices.");
    expect(src).toContain("Remaining {remainingDue} due");
    expect(src).toContain("dueAt");
    expect(src).toContain("due <= now");
    expect(src).not.toContain("Card {safeIndex + 1} of {cards.length}");
    expect(src).not.toMatch(/\{safeIndex \+ 1\} of \{cards\.length\}/);
  });

  it("shows the next interval from the schedule after rating, then advances", () => {
    expect(src).toContain('if (rating === "again") return "show tonight"');
    expect(src).toContain("next in ${intervalDays} days");
    expect(src).toContain("data.card.intervalDays");
    expect(src).toContain("setScheduleHint(nextIntervalCopy(rating, data.card.intervalDays))");
    expect(src).toContain("setTimeout");
    expect(src).toContain("setRatedIds");
    expect(src).toContain("clientRequestId");
  });

  it("keeps the Carded name, Flip hint, cloze reveal, and previous/next", () => {
    expect(src).toContain("Carded is empty");
    expect(src).toContain("export function CardedView");
    expect(src).toContain(">Flip<");
    expect(src).toContain("Reveal blanks");
    expect(src).toContain("Previous");
    expect(src).toContain("Next");
    expect(src).not.toContain("Memorize / Exam");
  });

  it("does not put an em dash in Carded UI copy", () => {
    expect(src).not.toContain(EM_DASH);
  });
});
