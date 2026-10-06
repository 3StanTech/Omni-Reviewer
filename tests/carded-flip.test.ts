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

  it("routes window keys through isStudyKeyTarget: Space toggles, arrows browse, 1/2 grade, Enter never grades", () => {
    expect(src).toContain("if (!isStudyKeyTarget(event)) return;");
    const effect = src.slice(src.indexOf("function onKeyDown(event: KeyboardEvent)"), src.indexOf('window.addEventListener("keydown", onKeyDown)'));
    expect(effect).toContain('event.key === " "');
    expect(effect).toContain("toggleFlip();");
    expect(effect).not.toContain("setFlipped(true)");
    expect(effect).toContain('event.key === "ArrowLeft"');
    expect(effect).toContain("go(-1)");
    expect(effect).toContain('event.key === "ArrowRight"');
    expect(effect).toContain("go(1)");
    expect(effect).toContain('event.key === "1"');
    expect(effect).toContain('event.key === "2"');
    expect(effect).not.toContain('"Enter"');
    const controlGuard = effect.indexOf(`closest("button, a, [role='button'], summary")`);
    expect(controlGuard).toBeGreaterThan(-1);
    const spaceDefer = effect.indexOf('event.key === " " && control?.closest("[data-carded-root]")');
    expect(spaceDefer).toBeGreaterThan(controlGuard);
    expect(spaceDefer).toBeLessThan(effect.indexOf("toggleFlip();"));
  });

  it("shows a fine-pointer key hint, a phone thumb bar, and a focus-mode root", () => {
    expect(src).toContain("data-carded-root");
    expect(src).toContain("carded-key-hint");
    expect(src).toContain("@media (pointer: fine)");
    expect(src).toContain("Space flip · 1 Again · 2 Good · F focus");
    expect(src).toContain("← → move · Space flip · F focus");
    expect(src).toContain("carded-thumb-bar");
    expect(src).toContain("Show answer");
    expect(src).toContain("env(safe-area-inset-bottom)");
  });

  it("keeps Again and Good out of the tree until the card is flipped", () => {
    expect(src).toContain("isDurableCard(card) && flipped");
    const gradesBlock = src.slice(src.indexOf("isDurableCard(card) && flipped"));
    expect(gradesBlock).toContain("Again,");
    expect(gradesBlock).toContain("Good,");
    expect(gradesBlock).toContain("gradePreview");
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
    expect(src).toContain("todayCards(durableCards, examDate, Date.now()).length");
    expect(src).toContain("selectTodayCards(");
    expect(src).not.toContain("Card {safeIndex + 1} of {cards.length}");
    expect(src).not.toMatch(/\{safeIndex \+ 1\} of \{cards\.length\}/);
  });

  it("previews each button from the card's nextIntervals and hints the saved interval", () => {
    expect(src).not.toContain("@/lib/sm2");
    expect(src).toContain("card.nextIntervals[rating].days");
    expect(src).toContain('days === 1 ? "tomorrow" : `in ${days} days`');
    expect(src).toContain("setScheduleHint(`Next review ${intervalCopy(data.card.intervalDays)}`)");
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

  it("shows citations on the back only and never flips when a chip is used", () => {
    expect(src).toContain("const frontSource = stripCitations(");
    expect(src).toContain("inert={!flipped}");
    const back = src.slice(src.indexOf('className="carded-face carded-back"'));
    expect(back.slice(0, 400)).toContain("event.stopPropagation()");
    expect(src).toContain('closest("button, a, [data-cite-source]")');
  });

  it("offers a Slide button after the flip when the back cites a page", () => {
    expect(src).toContain("card && flipped ? firstPageCitation([card.back]) : null");
    expect(src).toContain("sourceViewer.available");
    expect(src).toContain("Slide {backPage}");
    expect(src).toContain("<Presentation");
  });
});

