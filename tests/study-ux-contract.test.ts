import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isClozeCardFront,
  isValidCardFront,
  parseCardedItems,
  parseClozeText,
  renderClozeText,
} from "@/lib/learning";
import {
  cardedPrompt,
  lockedInPrompt,
  summaryPrompt,
  testMePrompt,
} from "@/lib/prompts";
import {
  MAX_STUDY_MARKDOWN_CHARS,
  MAX_STUDY_MATH_BLOCKS,
  MAX_STUDY_MATH_CHARS,
  prepareStudyMarkdown,
} from "@/lib/study-markdown";

const root = path.resolve(__dirname, "..");

describe("study Markdown and cloze contracts", () => {
  it("accepts GFM/math-sized content and fails closed over render budgets", () => {
    const source = "# Notes\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$E=mc^2$";
    expect(prepareStudyMarkdown(source)).toMatchObject({ mathBlocks: 1 });
    expect(prepareStudyMarkdown("x".repeat(MAX_STUDY_MARKDOWN_CHARS + 1))).toBeNull();
    expect(
      prepareStudyMarkdown(Array.from({ length: MAX_STUDY_MATH_BLOCKS + 1 }, () => "$x$").join(" ")),
    ).toBeNull();
    expect(prepareStudyMarkdown("$" + "x".repeat(MAX_STUDY_MATH_CHARS) + "$"))
      .toBeNull();
  });

  it("scans unmatched math delimiters in bounded time", () => {
    const adversarial = "$" + "x".repeat(99_998);
    const start = performance.now();
    const prepared = prepareStudyMarkdown(adversarial);
    const elapsed = performance.now() - start;
    expect(prepared).toMatchObject({ mathBlocks: 0, mathChars: 0 });
    expect(elapsed).toBeLessThan(1_000);
    expect(prepareStudyMarkdown("$$x$$ and $y$ and \\(z\\)")).toMatchObject({
      mathBlocks: 3,
    });
  });

  it("keeps repeated unmatched slash openers linear at the 80k/100k bounds", () => {
    for (const size of [80_000, 100_000]) {
      const adversarial = "\\(".repeat(size / 2);
      const start = performance.now();
      expect(prepareStudyMarkdown(adversarial)).toMatchObject({
        mathBlocks: 0,
        mathChars: 0,
      });
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });

  it("keeps Markdown HTML and URL behavior in one shared renderer", () => {
    const renderer = readFileSync(path.join(root, "components/study-markdown.tsx"), "utf8");
    expect(renderer).toContain("skipHtml");
    expect(renderer).toContain("remarkGfm");
    expect(renderer).toContain("remarkMath");
    expect(renderer).toContain("rehypeKatex");
    expect(renderer).toContain("rehypeSanitize");
    expect(renderer).toContain("trust: false");
    expect(renderer).toContain("output: \"mathml\"");
    expect(renderer).toContain("sanitizeMarkdownUrl");
    expect(renderer).not.toContain("rehypeRaw");
  });

  it("allowlists semantic ink span classes with KaTeX and still skips raw HTML", () => {
    const renderer = readFileSync(path.join(root, "components/study-markdown.tsx"), "utf8");
    const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
    expect(renderer).toContain("ink-idea|ink-example|ink-fact|ink-warning|ink-exam");
    expect(renderer).toContain("katex|katex-error");
    expect(renderer).toContain("remarkInkSpans");
    expect(renderer).toContain("skipHtml");
    expect(renderer).not.toContain("rehypeRaw");
    expect(renderer).toContain('!["img", "picture", "source"]');
    expect(css).toContain(".ink-idea");
    expect(css).toContain(".ink-example");
    expect(css).toContain(".ink-fact");
    expect(css).toContain(".ink-warning");
    expect(css).toContain(".ink-exam");
  });

  it("renders existing packs without a generated ink legend", () => {
    const lockedIn = readFileSync(path.join(root, "components/locked-in-view.tsx"), "utf8");
    const summary = readFileSync(path.join(root, "components/summary-view.tsx"), "utf8");
    const renderer = readFileSync(path.join(root, "components/study-markdown.tsx"), "utf8");
    const emDash = "\u2014";
    expect(prepareStudyMarkdown("# Notes\n\nPlain study text with no ink.")).toMatchObject({
      source: "# Notes\n\nPlain study text with no ink.",
    });
    expect(lockedIn).not.toContain("<InkLegend />");
    expect(summary).not.toContain("<InkLegend />");
    expect(renderer).not.toContain("InkLegend");
    expect(renderer).not.toContain(emDash);
    expect(lockedIn).not.toContain(emDash);
    expect(summary).not.toContain(emDash);
  });

  it("keeps generated study documents plain for user-managed highlights", () => {
    const lockedIn = lockedInPrompt([{ filename: "notes.txt", text: "Body" }]);
    const summary = summaryPrompt("Locked In body");
    const testMe = testMePrompt("Locked In body");
    const carded = cardedPrompt("Summary body");
    for (const klass of ["ink-idea", "ink-example", "ink-fact", "ink-warning", "ink-exam"]) {
      expect(lockedIn).not.toContain(`<span class="${klass}">`);
      expect(summary).not.toContain(`<span class="${klass}">`);
      expect(testMe).not.toContain(klass);
      expect(carded).not.toContain(klass);
    }
    expect(lockedIn).toContain("Do not add HTML spans, semantic ink classes, or automatic highlighting.");
    expect(summary).toContain("Do not add HTML spans, semantic ink classes, or automatic highlighting.");
  });

  it("parses and masks bounded cloze placeholders without changing legacy cards", () => {
    const parsed = parseClozeText("The capital of {{France}} is {{Paris}}.");
    expect(parsed?.answers).toEqual(["France", "Paris"]);
    expect(renderClozeText(parsed!.source)).toBe("The capital of _____ is _____.");
    expect(renderClozeText(parsed!.source, true)).toBe("The capital of France is Paris.");
    expect(isClozeCardFront(parsed!.source)).toBe(true);
    expect(isValidCardFront("Plain front with {braces}")).toBe(true);
    expect(isValidCardFront("Broken {{placeholder")).toBe(false);
    expect(parseCardedItems(null, JSON.stringify([
      { id: "c1", front: "The {{answer}}", back: "Explanation" },
      { id: "c1-explicit", type: "cloze", text: "The {{answer}}", back: "Explanation", cloze: { text: "The {{answer}}", answers: ["answer"] } },
      { id: "c2", front: "Broken {{answer", back: "Explanation" },
      { id: "c3", front: "Plain", back: "Legacy" },
    ]))).toEqual([
      { id: "c1", front: "The {{answer}}", back: "Explanation", kind: "cloze" },
      { id: "c1-explicit", front: "The {{answer}}", back: "Explanation", kind: "cloze" },
      { id: "c3", front: "Plain", back: "Legacy", kind: "basic" },
    ]);
  });

  it("uses the shared renderer in Test Me and Carded", () => {
    const testMe = readFileSync(path.join(root, "components/test-me-view.tsx"), "utf8");
    const carded = readFileSync(path.join(root, "components/carded-view.tsx"), "utf8");
    expect(testMe).toContain("<MarkdownBody source={item.question} />");
    expect(testMe).toContain("<MarkdownBody source={choice} inline />");
    expect(carded).toContain("renderClozeText");
    expect(carded).toContain("<MarkdownBody");
  });
});
