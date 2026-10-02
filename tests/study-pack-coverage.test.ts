import { describe, expect, it } from "vitest";

import { citedPageCount, generationBudget, studyItemTarget } from "@/lib/ai-budgets";
import { MAX_GENERATION_JSON_OUTPUT_TOKENS } from "@/lib/learning-limits";
import { cardedPrompt, summaryPrompt, summaryTargetChars, testMePrompt } from "@/lib/prompts";

/** One cited bullet per page, pages 1..n of source 1. */
function citedPages(n: number): string {
  return Array.from({ length: n }, (_, i) => `- Fact ${i + 1}. [S1 p.${i + 1}]`).join("\n");
}

const COVERAGE_RULE =
  "Cover every ## section in proportion to its length; every section with factual content gets at least one item. Do not cluster items in the opening sections.";
const NO_TRIVIA_RULE =
  "Skip quotations, epigraphs, mottos and motivational lines. Every card tests a definition, mechanism, drug, dose, number, classification or distinction.";

describe("citedPageCount", () => {
  it("counts single pages and expands ranges", () => {
    expect(citedPageCount("A. [S1 p.1] B. [S1 p.3]")).toBe(2);
    expect(citedPageCount("A. [S1 pp.14-15]")).toBe(2);
  });

  it("counts each page in a comma list", () => {
    expect(citedPageCount("A. [S1 p.2, p.3]")).toBe(2);
  });

  it("counts duplicates once and keeps sources distinct", () => {
    expect(citedPageCount("A. [S1 p.2] B. [S1 p.2] C. [S1 pp.1-2]")).toBe(2);
    expect(citedPageCount("A. [S1 p.2] B. [S2 p.2]")).toBe(2);
  });

  it("ignores whole-source citations", () => {
    expect(citedPageCount("A. [S2] B. [S3]")).toBe(0);
    expect(citedPageCount("A. [S2] B. [S1 p.4]")).toBe(1);
  });

  it("caps a huge range at 50 pages", () => {
    expect(citedPageCount("A. [S1 pp.1-9999]")).toBe(50);
  });
});

describe("studyItemTarget", () => {
  it("gives one question and two cards per cited page", () => {
    const md = citedPages(18);
    expect(studyItemTarget("test_me", md)).toBe(18);
    expect(studyItemTarget("carded", md)).toBe(36);
  });

  it("clamps to the upper bounds", () => {
    const md = citedPages(40);
    expect(studyItemTarget("test_me", md)).toBe(30);
    expect(studyItemTarget("carded", md)).toBe(60);
  });

  it("clamps to the lower bounds", () => {
    const md = citedPages(2);
    expect(studyItemTarget("test_me", md)).toBe(5);
    expect(studyItemTarget("carded", md)).toBe(10);
  });

  it("falls back to the length bands without page citations", () => {
    expect(studyItemTarget("test_me", "Short note. [S2]")).toBe(5);
    expect(studyItemTarget("carded", "Short note.")).toBe(10);
    const medium = "x".repeat(20_000);
    expect(studyItemTarget("test_me", medium)).toBe(10);
    expect(studyItemTarget("carded", medium)).toBe(20);
    const long = "x".repeat(60_000);
    expect(studyItemTarget("test_me", long)).toBe(20);
    expect(studyItemTarget("carded", long)).toBe(30);
  });
});

describe("generationBudget with maxItems", () => {
  it("uses the given items and scales output tokens", () => {
    expect(generationBudget("test_me", 1_000, { maxItems: 30 })).toMatchObject({
      maxItems: 30,
      maxOutputTokens: 30 * 350,
    });
    expect(generationBudget("carded", 1_000, { maxItems: 60 })).toMatchObject({
      maxItems: 60,
      maxOutputTokens: 60 * 200,
    });
  });

  it("never drops below the band target", () => {
    const band = generationBudget("test_me", 1_000).maxOutputTokens;
    expect(generationBudget("test_me", 1_000, { maxItems: 5 }).maxOutputTokens).toBe(band);
  });

  it("respects the hard output maximum", () => {
    expect(generationBudget("carded", 1_000, { maxItems: 10_000 }).maxOutputTokens).toBe(
      MAX_GENERATION_JSON_OUTPUT_TOKENS,
    );
  });

  it("is unchanged without maxItems", () => {
    expect(generationBudget("test_me", 1_000)).toMatchObject({ maxItems: 5, maxOutputTokens: 3_500 });
    expect(generationBudget("carded", 12_000)).toMatchObject({ maxItems: 30, maxOutputTokens: 14_000 });
  });
});

describe("study pack prompts", () => {
  const md = `## Intro\n\n${citedPages(18)}`;

  it("Test Me states the page-scaled count and the coverage rule", () => {
    const prompt = testMePrompt(md);
    expect(prompt).toContain("Return about 18 items (never more than 18)");
    expect(prompt).toContain(COVERAGE_RULE);
    expect(prompt).not.toContain(NO_TRIVIA_RULE);
  });

  it("Carded states the page-scaled count, coverage and no-trivia rules", () => {
    const prompt = cardedPrompt(md);
    expect(prompt).toContain("Return about 36 cards (never more than 36)");
    expect(prompt).toContain(COVERAGE_RULE);
    expect(prompt).toContain(NO_TRIVIA_RULE);
  });

  it("an explicit count overrides the default", () => {
    expect(testMePrompt(md, 7)).toContain("Return about 7 items (never more than 7)");
  });

  it("Summary targets about 40% of Locked In with table and heading rules", () => {
    const prompt = summaryPrompt("x".repeat(10_000));
    expect(prompt).toContain("Aim for about 4,000 characters, about 40% of Locked In's length.");
    expect(prompt).toContain("Do not number tables or figures from the slides");
    expect(prompt).toContain("Put no citations in headings");
    expect(prompt).not.toContain("denser and shorter");
    expect(prompt).not.toContain("—");
  });

  it("Summary target has a 1,500-character floor", () => {
    expect(summaryTargetChars("x".repeat(100))).toBe(1_500);
    expect(summaryTargetChars("x".repeat(19_673))).toBe(7_900);
  });
});
