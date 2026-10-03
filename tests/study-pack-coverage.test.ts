import { beforeEach, describe, expect, it, vi } from "vitest";

import { citedPageCount, generationBudget, studyItemTarget } from "@/lib/ai-budgets";
import { GENERATION_STEP_DEADLINE_MS, MAX_GENERATION_JSON_OUTPUT_TOKENS } from "@/lib/learning-limits";
import { NO_INVENT_CITATIONS, cardedPrompt, groundingVerifyPrompt, summaryPrompt, summaryHalfPrompt, summaryTargetChars, testMePrompt } from "@/lib/prompts";
import { allocateItems, balancedHalves, splitSections } from "@/lib/study-sections";
import { readStudyDocumentMeta } from "@/lib/citations";

vi.mock("server-only", () => ({}));

const generateText = vi.hoisted(() => vi.fn());
const generateObject = vi.hoisted(() => vi.fn());
const uncoveredSections = vi.hoisted(() => vi.fn<
  (markdown: string, items: readonly unknown[], textOf: (item: unknown) => string) =>
    Array<{ heading: string; markdown: string }>
>());

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateText(...args),
  generateObject: (...args: unknown[]) => generateObject(...args),
  NoObjectGeneratedError: class NoObjectGeneratedError extends Error {
    static isInstance(): boolean { return false; }
  },
}));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => (modelId: string) => ({ modelId }),
}));
// Section coverage itself has its own squad and tests; this suite controls its verdict.
vi.mock("@/lib/study-coverage", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/study-coverage")>(),
  uncoveredSections,
}));

import { generateStudyPackStep, getModelId } from "@/lib/ai";
import { GenerationError } from "@/lib/generation-errors";
import type { CardedItem, TestMeItem } from "@/lib/types";

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

describe("Summary half prompt contract", () => {
  const half = "## Foundations\n\nFact. [S1 p.1]\n\n## Mechanisms\n\nSecond fact. [S1 p.2]";
  const options = {
    part: 1 as const, parts: 2 as const,
    bulletLimits: [{ heading: "Foundations", bullets: 2 }, { heading: "Mechanisms", bullets: 7 }],
    targetChars: 2_400,
  };
  const strictSentence = "Your previous answer was too long or cut off. Use at most half the bullets.";

  it("lists each heading with its own bullet limit and forbids verbatim copying", () => {
    const prompt = summaryHalfPrompt(half, options);
    expect(prompt).toContain(half);
    for (const { heading, bullets } of options.bulletLimits) {
      const lines = prompt.split("\n").filter((line) => line.includes(heading) && /bullets?/i.test(line));
      expect(lines.some((line) => new RegExp(`\\b${bullets}\\b`).test(line))).toBe(true);
    }
    expect(prompt).toMatch(/(?:never|do not)[^\n]*copy[^\n]*verbatim/i);
    expect(prompt).toMatch(/(?:under|fewer than|less than) 30 words/i);
    expect(prompt).toMatch(/(?:at most|no more than|maximum(?: of)?) 6 rows/i);
    expect(prompt).not.toContain(strictSentence);
  });

  it("adds the exact strict sentence only for the strict retry", () => {
    expect(summaryHalfPrompt(half, { ...options, strict: true })).toContain(strictSentence);
    expect(summaryHalfPrompt(half, { ...options, strict: false })).not.toContain(strictSentence);
  });

  it("retains pharmacy, highlighting, citation, heading and document-framing rules", () => {
    const prompt = summaryHalfPrompt(half, { ...options, part: 2 });
    expect(prompt).toContain("Drug(s) | Mechanism | Key uses | Adverse effects | Interactions or contraindications");
    expect(prompt).toContain("Do not add HTML spans, semantic ink classes, or automatic highlighting");
    expect(prompt).toContain(NO_INVENT_CITATIONS);
    expect(prompt).toContain("Do not describe the document itself");
    expect(prompt).toContain("Put no citations in headings");
    expect(prompt).toContain("Do not number tables or figures from the slides");
    expect(prompt).toContain("Keep Locked In's citations verbatim");
    expect(prompt).not.toContain("—");
  });
});

describe.each(["test_me", "carded"] as const)("%s coverage top-up wiring", (kind) => {
  const markdown = ["Foundations", "Mechanisms", "Applications", "Safety", "Later material"]
    .map((heading, i) => `## ${heading}\n\n- Distinct supported section fact ${i + 1}. [S1 p.${i + 1}]`)
    .join("\n\n");
  const sections = splitSections(markdown).sections;
  const halves = balancedHalves(markdown);
  const target = studyItemTarget(kind, markdown);
  const counts = allocateItems(target, halves);
  const promptFor = kind === "test_me" ? testMePrompt : cardedPrompt;
  const freeModel = "z-ai/glm-5.2:free";
  type Item = TestMeItem | CardedItem;
  type SdkCall = { prompt: string; model: { modelId: string }; maxRetries: number };

  function item(label: string, page = 1): Item {
    return kind === "test_me"
      ? { id: `model-${label}`, question: `${label}?`, choices: ["Alpha", "Beta"], answer: "Alpha", explanation: `Supported ${label}. [S1 p.${page}]` }
      : { id: `model-${label}`, front: label, back: `Supported ${label}. [S1 p.${page}]` };
  }
  function promptText(value: Item): string {
    return "question" in value ? value.question : value.front;
  }
  function sdkCall(index: number): SdkCall {
    return generateObject.mock.calls[index]![0] as SdkCall;
  }
  function baseItems(): Item[] {
    return counts.flatMap((count, half) => Array.from({ length: count }, (_, i) => item(`Base ${half + 1} item ${i + 1}`)));
  }
  function mockBase(extra: Item[] = []) {
    generateObject.mockResolvedValueOnce({ object: baseItems().slice(0, counts[0]), response: { modelId: freeModel } })
      .mockResolvedValueOnce({ object: baseItems().slice(counts[0]), response: { modelId: freeModel } });
    for (const value of extra) generateObject.mockResolvedValueOnce({ object: [value], response: { modelId: freeModel } });
  }
  async function run(): Promise<Item[]> {
    const result = await generateStudyPackStep({
      step: kind,
      // Carded's selected input must remain the Summary; it cannot top up from Locked In.
      lockedIn: kind === "test_me" ? markdown : "LOCKED_IN_SHOULD_NOT_BE_USED",
      summary: kind === "carded" ? markdown : "SUMMARY_SHOULD_NOT_BE_USED",
      citationSources: [{ index: 1, sourceId: "src-1", filename: "notes.pdf", hasPages: true }],
    });
    expect(result.modelUsed).toBe(freeModel);
    return result.payload.content as Item[];
  }

  beforeEach(() => {
    generateText.mockReset();
    generateObject.mockReset();
    uncoveredSections.mockReset().mockReturnValue([]);
    process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdefgh";
    process.env.AUTH_TRUST_HOST = "true";
    process.env.DATABASE_URL = "postgresql://user:password@example.test/db";
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
    process.env.AUTH_URL = "http://localhost:3000";
    process.env.OPENROUTER_API_KEY = "test-key-not-real";
    process.env.AI_MODEL_LOCKED_IN = freeModel;
    process.env.AI_MODEL_SUMMARY = freeModel;
    process.env.AI_MODEL_JSON = freeModel;
    process.env.AI_MODEL_FALLBACKS = "nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,openrouter/free";
  });

  it("checks the merged base items and makes no top-up when every section is covered", async () => {
    mockBase();
    const items = await run();
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(uncoveredSections).toHaveBeenCalledTimes(1);
    const [input, merged, textOf] = uncoveredSections.mock.calls[0];
    expect(input).toBe(markdown);
    expect(merged).toHaveLength(target);
    const sample = item("Specific fact", 5);
    expect(textOf(sample)).toContain(promptText(sample));
    expect(textOf(sample)).toContain("[S1 p.5]");
    expect(items.map(promptText)).toEqual(baseItems().map(promptText));
    expect(generateText).not.toHaveBeenCalled();
  });

  it("starts three one-item section top-ups in parallel, each using only its own markdown and the same free model", async () => {
    const missing = sections.slice(2);
    const extra = missing.map((section, i) => item(`Coverage for ${section.heading}`, i + 3));
    type Reply = { object: Item[]; response: { modelId: string } };
    const finishers: Array<(value: Reply) => void> = [];
    const pendingSections = extra.map(() => new Promise<Reply>((resolve) => { finishers.push(resolve); }));
    uncoveredSections.mockReturnValue(missing);
    mockBase();
    for (const pendingSection of pendingSections) generateObject.mockReturnValueOnce(pendingSection);
    const pending = run();
    try {
      // No section response has completed; all three SDK calls must already be in flight.
      await vi.waitFor(() => expect(generateObject).toHaveBeenCalledTimes(5));
      for (const [i, section] of missing.entries()) {
        const topUp = sdkCall(i + 2);
        expect(topUp.prompt).toBe(promptFor(section.markdown, 1));
        expect(topUp.prompt).toContain(`Return about 1 ${kind === "test_me" ? "items" : "cards"} (never more than 1)`);
        for (const other of sections.filter((value) => value.heading !== section.heading)) {
          expect(topUp.prompt).not.toContain(other.markdown);
        }
      }
      const models = generateObject.mock.calls.map((_call, i) => sdkCall(i).model.modelId);
      expect(models).toEqual(Array(5).fill(getModelId("json")));
      expect(models.every((model) => model === freeModel && model.endsWith(":free"))).toBe(true);
      expect(generateObject.mock.calls.every((_call, i) => sdkCall(i).maxRetries === 0)).toBe(true);
      // Resolve in reverse order; merge order still follows the section order.
      for (let i = extra.length - 1; i >= 0; i--) finishers[i]({ object: [extra[i]], response: { modelId: freeModel } });
    } finally {
      for (const [i, finish] of finishers.entries()) finish({ object: [extra[i]], response: { modelId: freeModel } });
      await pending;
    }
    const items = await pending;
    expect(items.slice(-3).map(promptText)).toEqual(extra.map(promptText));
    expect(generateObject).toHaveBeenCalledTimes(5);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("selects only the three sections with the most cited pages out of five, keeping document order", async () => {
    const definitions = [
      { heading: "One page", pages: "p.1" },
      { heading: "Four pages", pages: "pp.2-5" },
      { heading: "Two pages", pages: "pp.6-7" },
      { heading: "Five pages", pages: "pp.8-12" },
      { heading: "Three pages", pages: "pp.13-15" },
    ];
    const input = definitions.map(({ heading, pages }) => `## ${heading}\n\n- A supported fact. [S1 ${pages}]`).join("\n\n");
    const inputSections = splitSections(input).sections;
    const selected = [inputSections[1], inputSections[3], inputSections[4]];
    const inputTotal = studyItemTarget(kind, input);
    const inputCounts = allocateItems(inputTotal, balancedHalves(input));
    const base = Array.from({ length: inputTotal }, (_, i) => item(`Weighted base ${i + 1}`));
    const extra = selected.map((section, i) => item(`Top-up ${section.heading}`, [2, 8, 13][i]));
    uncoveredSections.mockReturnValue(inputSections);
    generateObject.mockResolvedValueOnce({ object: base.slice(0, inputCounts[0]), response: { modelId: freeModel } })
      .mockResolvedValueOnce({ object: base.slice(inputCounts[0]), response: { modelId: freeModel } });
    for (const value of extra) generateObject.mockResolvedValueOnce({ object: [value], response: { modelId: freeModel } });
    const result = await generateStudyPackStep({
      step: kind,
      lockedIn: kind === "test_me" ? input : "LOCKED_IN_SHOULD_NOT_BE_USED",
      summary: kind === "carded" ? input : "SUMMARY_SHOULD_NOT_BE_USED",
      citationSources: [{ index: 1, sourceId: "src-1", filename: "notes.pdf", hasPages: true }],
    });
    expect(generateObject).toHaveBeenCalledTimes(5);
    const topUpPrompts = generateObject.mock.calls.slice(2).map((call) => (call[0] as SdkCall).prompt);
    expect(topUpPrompts).toEqual(selected.map((section) => promptFor(section.markdown, 1)));
    for (const prompt of topUpPrompts) {
      expect(prompt).not.toContain(inputSections[0].markdown);
      expect(prompt).not.toContain(inputSections[2].markdown);
    }
    expect(generateObject.mock.calls.every((_call, i) => sdkCall(i).model.modelId === freeModel)).toBe(true);
    expect(result.modelUsed).toBe(freeModel);
    expect((result.payload.content as Item[]).slice(-3).map(promptText)).toEqual(extra.map(promptText));
    expect(generateText).not.toHaveBeenCalled();
  });

  it("skips one rejected section top-up while merging the other section items", async () => {
    const missing = sections.slice(2);
    const extra = missing.map((section, i) => item(`Top-up ${section.heading}`, i + 3));
    uncoveredSections.mockReturnValue(missing);
    mockBase();
    generateObject.mockResolvedValueOnce({ object: [extra[0]], response: { modelId: freeModel } })
      .mockRejectedValueOnce(new GenerationError("unknown", "Section top-up rejected.", false))
      .mockResolvedValueOnce({ object: [extra[2]], response: { modelId: freeModel } });
    const items = await run();
    expect(generateObject).toHaveBeenCalledTimes(5);
    expect(generateObject.mock.calls.slice(2).map((call) => (call[0] as SdkCall).prompt))
      .toEqual(missing.map((section) => promptFor(section.markdown, 1)));
    expect(items.slice(-2).map(promptText)).toEqual([promptText(extra[0]), promptText(extra[2])]);
    expect(items.map(promptText)).not.toContain(promptText(extra[1]));
    expect(items.some((value) => baseItems().some((base) => promptText(base) === promptText(value)))).toBe(true);
    expect(items).toHaveLength(Math.min(target + 2, Math.ceil(target * 1.2)));
    expect(generateObject.mock.calls.every((_call, i) => sdkCall(i).model.modelId === freeModel)).toBe(true);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("requests and accepts exactly one top-up item for one uncovered section", async () => {
    uncoveredSections.mockReturnValue([sections[4]]);
    mockBase();
    generateObject.mockResolvedValueOnce({
      object: [item("Last section fact", 5), item("Unrequested extra fact", 5)],
      response: { modelId: freeModel },
    });
    const items = await run();
    expect(sdkCall(2).prompt).toBe(promptFor(sections[4].markdown, 1));
    expect(items.map(promptText)).toContain(promptText(item("Last section fact", 5)));
    expect(items.map(promptText)).not.toContain(promptText(item("Unrequested extra fact", 5)));
    expect(items).toHaveLength(target + 1);
  });

  it("keeps the base items when the top-up rejects", async () => {
    uncoveredSections.mockReturnValue([sections[4]]);
    mockBase();
    generateObject.mockRejectedValueOnce(new GenerationError("unknown", "Top-up rejected.", false));
    const items = await run();
    expect(items.map(promptText)).toEqual(baseItems().map(promptText));
    expect(items).toHaveLength(target);
    expect(generateObject).toHaveBeenCalledTimes(3);
  });

  it.each([[215_000, true], [215_001, false]] as const)(
    "with base halves finishing at %i ms, top-up eligibility is %s", async (elapsed, shouldTopUp) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let completeBase!: (value: { object: Item[]; response: { modelId: string } }) => void;
      const slow = new Promise<{ object: Item[]; response: { modelId: string } }>((resolve) => { completeBase = resolve; });
      const missing = sections.slice(2);
      const extra = missing.map((section, i) => item(`Late coverage ${section.heading}`, i + 3));
      uncoveredSections.mockReturnValue(missing);
      generateObject.mockReturnValueOnce(slow)
        .mockResolvedValueOnce({ object: baseItems().slice(counts[0]), response: { modelId: freeModel } });
      for (const value of extra) generateObject.mockResolvedValueOnce({ object: [value], response: { modelId: freeModel } });
      const pending = run();
      try {
        await vi.advanceTimersByTimeAsync(elapsed);
        completeBase({ object: baseItems().slice(0, counts[0]), response: { modelId: freeModel } });
        const items = await pending;
        expect(uncoveredSections).toHaveBeenCalledTimes(1);
        expect(generateObject).toHaveBeenCalledTimes(shouldTopUp ? 5 : 2);
        if (shouldTopUp) {
          for (const value of extra) expect(items.map(promptText)).toContain(promptText(value));
        } else {
          expect(items.map(promptText)).toEqual(baseItems().map(promptText));
          expect(items).toHaveLength(target);
        }
      } finally {
        completeBase({ object: baseItems().slice(0, counts[0]), response: { modelId: freeModel } });
        await pending;
        vi.useRealTimers();
      }
    },
  );

  it("caps a top-up's abort deadline to the remaining item-step time and keeps base items on timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let completeBase!: (value: { object: Item[]; response: { modelId: string } }) => void;
    let completeTopUp: ((value: { object: Item[]; response: { modelId: string } }) => void) | undefined;
    let topUpSignal: AbortSignal | undefined;
    const slow = new Promise<{ object: Item[]; response: { modelId: string } }>((resolve) => { completeBase = resolve; });
    uncoveredSections.mockReturnValue([sections[4]]);
    generateObject.mockReturnValueOnce(slow)
      .mockResolvedValueOnce({ object: baseItems().slice(counts[0]), response: { modelId: freeModel } })
      .mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => {
        topUpSignal = abortSignal;
        return new Promise((resolve, reject) => {
          completeTopUp = resolve;
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        });
      });
    const pending = run();
    try {
      await vi.advanceTimersByTimeAsync(200_000);
      completeBase({ object: baseItems().slice(0, counts[0]), response: { modelId: freeModel } });
      await vi.advanceTimersByTimeAsync(0);
      expect(generateObject).toHaveBeenCalledTimes(3);
      const remaining = GENERATION_STEP_DEADLINE_MS - 10_000 - Date.now();
      expect(remaining).toBe(60_000);
      expect(topUpSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(remaining - 1);
      expect(topUpSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(topUpSignal?.aborted).toBe(true);
      expect((await pending).map(promptText)).toEqual(baseItems().map(promptText));
      expect(generateObject).toHaveBeenCalledTimes(3);
    } finally {
      completeBase({ object: baseItems().slice(0, counts[0]), response: { modelId: freeModel } });
      completeTopUp?.({ object: [item("Coverage fact", 5)], response: { modelId: freeModel } });
      await pending;
      vi.useRealTimers();
    }
  });

  if (kind === "test_me") {
    it("preserves the only page-5 citation when trimming eight base items plus three top-ups to ten", async () => {
      const input = Array.from({ length: 8 }, (_, i) => `## Section ${i + 1}\n\nFact. [S1 p.${i + 1}]`).join("\n\n");
      const inputSections = splitSections(input).sections;
      const inputHalves = balancedHalves(input);
      const total = studyItemTarget("test_me", input);
      const inputCounts = allocateItems(total, inputHalves);
      expect(total).toBe(8);
      expect(Math.ceil(total * 1.2)).toBe(10);
      // Distinct prompts with repeated page coverage, rather than identical items deduped by ID.
      const base = [1, 2, 3, 4, 1, 2, 3, 5].map((page, i) => item(`Base coverage ${i + 1}`, page));
      const extra = [6, 7, 8].map((page) => item(`Top-up page ${page}`, page));
      uncoveredSections.mockReturnValue(inputSections.slice(5));
      generateObject.mockResolvedValueOnce({ object: base.slice(0, inputCounts[0]), response: { modelId: freeModel } })
        .mockResolvedValueOnce({ object: base.slice(inputCounts[0]), response: { modelId: freeModel } });
      for (const value of extra) generateObject.mockResolvedValueOnce({ object: [value], response: { modelId: freeModel } });
      const result = await generateStudyPackStep({
        step: "test_me", lockedIn: input,
        citationSources: [{ index: 1, sourceId: "src-1", filename: "notes.pdf", hasPages: true }],
      });
      const items = result.payload.content as TestMeItem[];
      expect(generateObject).toHaveBeenCalledTimes(5);
      expect(items).toHaveLength(10);
      for (let page = 1; page <= 8; page++) {
        expect(items.some((value) => value.explanation.includes(`[S1 p.${page}]`))).toBe(true);
      }
      expect(items.map(promptText)).toContain(promptText(base[7]));
      for (const value of extra) expect(items.map(promptText)).toContain(promptText(value));
      const dropped = base.filter((value) => !items.some((kept) => promptText(kept) === promptText(value)));
      expect(dropped).toHaveLength(1);
      expect(dropped.every((value) => /\[S1 p\.[123]\]/.test((value as TestMeItem).explanation))).toBe(true);
    });
  }

  it("caps the final merge at ceil(target * 1.2) while retaining every top-up item", async () => {
    const missing = kind === "test_me" ? sections.slice(3) : sections.slice(2);
    const extra = missing.map((section, i) => item(`Top-up ${section.heading}`, i + 3));
    expect(target + extra.length).toBeGreaterThan(Math.ceil(target * 1.2));
    uncoveredSections.mockReturnValue(missing);
    mockBase(extra);
    const items = await run();
    expect(items).toHaveLength(Math.ceil(target * 1.2));
    for (const extraItem of extra) expect(items.map(promptText)).toContain(promptText(extraItem));
    expect(new Set(items.map((value) => value.id)).size).toBe(items.length);
  });

  it("deduplicates base and top-up prompts and preserves content IDs across provider item IDs and citation changes", async () => {
    uncoveredSections.mockReturnValue([sections[4]]);
    mockBase([item("Shared coverage fact", 5)]);
    const first = await run();
    const expected = first.find((value) => promptText(value) === promptText(item("Shared coverage fact", 5)))!;
    expect(expected).toBeDefined();
    generateObject.mockReset();
    mockBase([{
      ...item("Shared coverage fact", 4), id: "different-provider-id",
      ...(kind === "test_me" ? { question: "  Shared  coverage fact? [S1 p.4]" } : { front: "  Shared  coverage fact [S1 p.4]" }),
    } as Item]);
    const second = await run();
    const same = second.find((value) => value.id === expected.id);
    expect(same).toBeDefined();
    const pattern = kind === "test_me" ? /^q-[0-9a-f]{8}$/ : /^c-[0-9a-f]{8}$/;
    for (const value of [...first, ...second]) expect(value.id).toMatch(pattern);

    generateObject.mockReset();
    // The top-up repeats a base prompt with another citation; it must not create a second item.
    mockBase([{ ...baseItems()[0], id: "top-up-duplicate" }]);
    const deduplicated = await run();
    expect(deduplicated).toHaveLength(target);
    expect(new Set(deduplicated.map((value) => value.id)).size).toBe(target);
    const originalBase = first.find((value) => promptText(value) === promptText(baseItems()[0]))!;
    expect(deduplicated.find((value) => value.id === originalBase.id)).toBeDefined();
  });
});
