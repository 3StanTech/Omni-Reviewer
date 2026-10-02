import { describe, expect, it } from "vitest";

import { citedPageCount, generationBudget, studyItemTarget } from "@/lib/ai-budgets";
import { MAX_GENERATION_JSON_OUTPUT_TOKENS } from "@/lib/learning-limits";
import { cardedPrompt, groundingVerifyPrompt, summaryPrompt, summaryTargetChars, testMePrompt } from "@/lib/prompts";
import { splitSections } from "@/lib/study-sections";
import { readStudyDocumentMeta } from "@/lib/citations";

/** One cited bullet per page, pages 1..n of source 1. */
function citedPages(n: number): string {
  return Array.from({ length: n }, (_, i) => `- Fact ${i + 1}. [S1 p.${i + 1}]`).join("\n");
}

const COVERAGE_RULE =
  "Cover every ## section in proportion to its length; every section with factual content gets at least one item. Do not cluster items in the opening sections.";
const NO_TRIVIA_RULE =
  "Skip quotations, epigraphs, mottos and motivational lines. Every card tests a definition, mechanism, drug, dose, number, classification or distinction.";

describe("persisted grounding unchecked keys", () => {
  const report = {
    total: 8, cited: 6, lexicalSupported: 3, verifiedSupported: 1,
    unsourced: 1, unchecked: 3, truncated: true, verifierFailed: false,
  };
  const citationSources = [{ index: 1, sourceId: "src-1", filename: "notes.pdf", hasPages: true }];

  it.each([
    ["ordinary keys", ["12345678", "abcdef01"]],
    ["empty list", []],
    ["maximum length and count", Array(500).fill("x".repeat(16))],
  ])("preserves a valid uncheckedKeys array: %s", (_name, uncheckedKeys) => {
    const meta = readStudyDocumentMeta({ citationSources, grounding: { ...report, uncheckedKeys } });
    expect(meta).toEqual({ citationSources, grounding: { ...report, uncheckedKeys } });
  });

  it.each([
    ["non-array", "12345678"],
    ["null", null],
    ["non-string entry", ["12345678", 7]],
    ["oversized key", ["x".repeat(17)]],
    ["oversized list", Array(501).fill("12345678")],
  ])("drops malformed uncheckedKeys while keeping the report: %s", (_name, uncheckedKeys) => {
    const meta = readStudyDocumentMeta({ citationSources, grounding: { ...report, uncheckedKeys } });
    expect(meta).toEqual({ citationSources, grounding: report });
    expect(meta?.grounding).not.toHaveProperty("uncheckedKeys");
  });
});

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
    expect(prompt).not.toContain("Section budgets (about 40% of each Locked In section):");
  });

  it("lists rounded, floored per-section Summary budgets after the total target", () => {
    const lockedIn = "Preamble ".repeat(100) + "\n\n" + [
      "## Tiny\n\nFact.".padEnd(98, " ") + "\n\n",
      "## Mechanisms\n\nDetails.".padEnd(1_011, "x") + "\n\n",
      "## Clinical applications\n\nDetails.".padEnd(4_037, "x"),
    ].join("");
    const prompt = summaryPrompt(lockedIn);
    const budgetHeading = "Section budgets (about 40% of each Locked In section):";
    const totalLine = `Aim for about ${summaryTargetChars(lockedIn).toLocaleString("en-US")} characters, about 40% of Locked In's length.`;
    const sections = splitSections(lockedIn).sections;
    const expectedBudgets = [150, 410, 1_610];

    expect(sections).toHaveLength(3);
    expect(prompt).toContain(totalLine);
    expect(prompt.indexOf(budgetHeading)).toBeGreaterThan(prompt.indexOf(totalLine));
    for (const [i, section] of sections.entries()) {
      const budget = Math.max(150, Math.round(section.markdown.length * 0.4 / 10) * 10);
      expect(budget).toBe(expectedBudgets[i]);
      expect(prompt).toContain(`- ${section.heading}: about ${budget.toLocaleString("en-US")} characters`);
    }
    expect(prompt.match(/^- .+: about [\d,]+ characters$/gm)).toHaveLength(sections.length);
    expect(prompt).toContain("Do not number tables or figures from the slides");
    expect(prompt).toContain("Put no citations in headings");
  });

  it("omits per-section Summary budgets for a single-section Locked In", () => {
    const prompt = summaryPrompt(md);
    expect(splitSections(md).sections).toHaveLength(1);
    expect(prompt).toContain(`Aim for about ${summaryTargetChars(md).toLocaleString("en-US")} characters, about 40% of Locked In's length.`);
    expect(prompt).not.toContain("Section budgets (about 40% of each Locked In section):");
    expect(prompt).not.toMatch(/^- Intro: about [\d,]+ characters$/m);
  });

  it("keeps verifier rules and JSON shape while allowing supported paraphrases", () => {
    const prompt = groundingVerifyPrompt([{ id: 3, sentence: "A claim.", evidence: "Page text." }]);
    const lines = prompt.split("\n");
    expect(lines).toContain("- Paraphrase, synonyms, abbreviations, summarising several evidence lines, and reordering are not missing.");
    expect(lines).toContain("- Do not list connective words, framing, or general phrasing. List only specific facts (names, numbers, drugs, doses, mechanisms, causes, examples) that the evidence never states.");
    expect(prompt).toContain("ONLY against the evidence text given in the same item");
    expect(prompt).toContain('List in "missing" every fact, name, number, mechanism, cause, or example');
    expect(prompt).toContain('A sentence whose facts are all stated in its evidence has an empty "missing" list.');
    expect(prompt).toContain("Ignore bracket citations such as [S1 p.14] inside the sentence.");
    expect(prompt).toContain("Return one entry per item, keeping each id.");
    expect(prompt).toContain('[{"id": 0, "missing": []}, {"id": 1, "missing": ["acute tubular necrosis"]}]');
    expect(prompt).toContain('[{"id":3,"sentence":"A claim.","evidence":"Page text."}]');
    expect(prompt).toContain("No markdown fences, no commentary.");
  });

  it("Summary target has a 1,500-character floor", () => {
    expect(summaryTargetChars("x".repeat(100))).toBe(1_500);
    expect(summaryTargetChars("x".repeat(19_673))).toBe(7_900);
  });
});
