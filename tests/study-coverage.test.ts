import { describe, expect, it } from "vitest";
import { itemPages, sectionPages, uncoveredSections } from "@/lib/study-coverage";

const TRANS_5_SECTIONS = [
  ["I", "[S1 p.1]"],
  ["II", "[S1 pp.1-4]"],
  ["III", "[S1 pp.5-8]"],
  ["IV", "[S1 p.9]"],
  ["V", "[S1 pp.9-11, p.18]"],
  ["VI", "[S1 p.12]"],
  ["VII", "[S1 p.13]"],
  ["VIII", "[S1 p.13]"],
  ["IX", "[S1 p.14]"],
  ["X", "[S1 p.18]"],
].map(([heading, citation]) => ({ heading, markdown: `## ${heading}\nSection facts. ${citation}\n\n` }));
const TRANS_5 = TRANS_5_SECTIONS.map((section) => section.markdown).join("");

describe("itemPages", () => {
  it.each([
    ["Fact. [S1 p.9]", [9]],
    ["Fact. [S1 pp.10-11]", [10, 11]],
    ["Fact. [S1 p.3, p.5]", [3, 5]],
    ["Fact. [S1 pp.9-11, p.18]", [9, 10, 11, 18]],
    ["[S1 p.3] [S2 pp.3-5] [S1 p.5]", [3, 4, 5]],
    ["No citation; p.9 and 18 are ordinary text.", []],
    ["Whole-source citation. [S1]", []],
    ["", []],
  ] as const)("collects cited pages from %s", (text, pages) => {
    expect(itemPages(text)).toEqual(new Set(pages));
  });
});

describe("sectionPages", () => {
  it("keeps each level-two section's heading, markdown, and cited page set", () => {
    const first = "## Mechanisms\nFirst fact. [S1 p.9]\n### Details\nMore facts. [S1 pp.10-11]\n\n";
    const second = "## Treatment\nAnother fact. [S1 p.3, p.5]\n";
    const third = "## Overview\nNo page citations here. [S1]";
    expect(sectionPages(`# Title\nPreamble. [S1 p.99]\n\n${first}${second}${third}`)).toEqual([
      { heading: "Mechanisms", markdown: first, pages: new Set([9, 10, 11]) },
      { heading: "Treatment", markdown: second, pages: new Set([3, 5]) },
      { heading: "Overview", markdown: third, pages: new Set() },
    ]);
  });

  it("collects the Trans 5 page sets without borrowing pages from adjacent sections", () => {
    expect(sectionPages(TRANS_5).map((section) => section.pages)).toEqual([
      new Set([1]), new Set([1, 2, 3, 4]), new Set([5, 6, 7, 8]),
      new Set([9]), new Set([9, 10, 11, 18]), new Set([12]),
      new Set([13]), new Set([13]), new Set([14]), new Set([18]),
    ]);
  });

  it.each(["", "# Title\nOnly a preamble. [S1 p.1]", "### Detail\nFact. [S1 p.2]"])(
    "returns no sections without a level-two heading: %j",
    (markdown) => expect(sectionPages(markdown)).toEqual([]),
  );
});

describe("uncoveredSections", () => {
  it("compares the source and page together when two sources both cite page 1 (R7)", () => {
    const first = "## First source\nFact. [S1 p.1]\n\n";
    const second = "## Second source\nDifferent fact. [S2 p.1]\n";
    expect(uncoveredSections(first + second, ["Card. [S1 p.1]"], (item) => item)).toEqual([
      { heading: "Second source", markdown: second },
    ]);
    expect(uncoveredSections(first + second, ["Card. [S2 p.1]"], (item) => item)).toEqual([
      { heading: "First source", markdown: first },
    ]);
    expect(uncoveredSections(first + second, ["Card. [S1 p.1] [S2 p.1]"], (item) => item)).toEqual([]);
  });

  it("keeps cited ranges scoped to their source when deciding coverage (R7)", () => {
    const first = "## First range\nFacts. [S1 pp.2-4]\n\n";
    const second = "## Second range\nOther facts. [S2 pp.2-4]\n";
    expect(uncoveredSections(first + second, ["Card. [S1 p.3]"], (item) => item)).toEqual([
      { heading: "Second range", markdown: second },
    ]);
    expect(uncoveredSections(first + second, ["Card. [S1 pp.2-4, p.9]"], (item) => item)).toEqual([
      { heading: "Second range", markdown: second },
    ]);
  });

  it("returns only IX and X when Trans 5 items cite pages 1 through 13", () => {
    const items = [{ question: "Earlier material", answer: "Answer. [S1 pp.1-13]" }];
    const uncovered = uncoveredSections(TRANS_5, items, (item) => `${item.question}\n${item.answer}`);
    expect(uncovered).toEqual(TRANS_5_SECTIONS.slice(8));
    expect(uncovered.map((section) => section.heading)).not.toContain("V");
  });

  it("uses citations in any text selected by textOf, including an answer", () => {
    const items = [
      { prompt: "Prompt [S1 pp.1-13]", answer: "Answer [S1 p.14]" },
      { prompt: "Another prompt", answer: "Answer [S1 p.18]" },
    ];
    expect(uncoveredSections(TRANS_5, items, (item) => `${item.prompt} ${item.answer}`)).toEqual([]);
    expect(uncoveredSections(TRANS_5, items, (item) => item.prompt)).toEqual(TRANS_5_SECTIONS.slice(8));
  });

  it("treats one shared page as coverage even when a section cites other pages", () => {
    const markdown = "## Mixed\nFacts. [S1 pp.9-11, p.18]";
    expect(uncoveredSections(markdown, ["Card. [S1 p.10]"], (item) => item)).toEqual([]);
  });

  it("skips sections with no cited pages, even when no items exist", () => {
    const cited = "## Cited\nFact. [S1 p.4]\n";
    const uncited = "## Uncited\nNo page citation.\n## Whole source\nFact. [S1]";
    expect(uncoveredSections(cited + uncited, [], (item: string) => item)).toEqual([
      { heading: "Cited", markdown: cited },
    ]);
  });

  it("returns cited sections in document order when items have no matching page", () => {
    expect(uncoveredSections(TRANS_5, ["Unrelated. [S1 p.99]", "Uncited item."], (item) => item))
      .toEqual(TRANS_5_SECTIONS);
  });
});
