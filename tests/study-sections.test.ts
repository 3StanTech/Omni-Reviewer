import { describe, expect, it } from "vitest";

import { citedPageCount } from "@/lib/ai-budgets";
import { allocateItems, balancedHalves, splitSections } from "@/lib/study-sections";

function citedPages(count: number): string {
  return Array.from({ length: count }, (_, index) => `Fact. [S1 p.${index + 1}]`).join("\n");
}

describe("splitSections", () => {
  it("keeps the preamble and exact section substrings, trimming only heading metadata", () => {
    const preamble = "# Study notes\n\nIntroduction.\n\n";
    const first = "##   Mechanisms  \nFirst fact.\n### Detail\nMore detail.\n\n";
    const second = "## Treatment\nLast fact.";

    expect(splitSections(preamble + first + second)).toEqual({
      preamble,
      sections: [
        { heading: "Mechanisms", markdown: first },
        { heading: "Treatment", markdown: second },
      ],
    });
  });

  it("has an empty preamble when the document begins with a section", () => {
    expect(splitSections("## First\nBody\n## Second")).toEqual({
      preamble: "",
      sections: [
        { heading: "First", markdown: "## First\nBody\n" },
        { heading: "Second", markdown: "## Second" },
      ],
    });
  });

  it("does not treat deeper headings or text without the literal ## space prefix as sections", () => {
    const markdown = "# Title\n### Detail\n#### More\n##No space\n ## Indented\n##\tTab";
    expect(splitSections(markdown)).toEqual({ preamble: markdown, sections: [] });
  });

  it.each(["```", "~~~"])("ignores section-looking lines inside %s fences", (fence) => {
    const preamble = `${fence}markdown\n## Hidden in preamble\n${fence}\n`;
    const first = `## First\n${fence}\n## Hidden in section\n### Also hidden\n${fence}\nBody.\n`;
    const second = "## Second\nEnd.";

    expect(splitSections(preamble + first + second)).toEqual({
      preamble,
      sections: [
        { heading: "First", markdown: first },
        { heading: "Second", markdown: second },
      ],
    });
  });

  it("does not close a backtick fence when a fence-looking line has an info string", () => {
    const preamble = "```\n```javascript\n## Table 4: Code [S1 p.1]\n```\n";
    const section = "## Visible\nBody.\n";
    expect(splitSections(preamble + section)).toEqual({
      preamble,
      sections: [{ heading: "Visible", markdown: section }],
    });
  });

  it.each(["```   ", "``` \t", "   ```` \t"])(
    "closes a backtick fence with a bare closer and trailing whitespace: %j",
    (closer) => {
      const preamble = ["```javascript", "## Hidden", closer, ""].join("\n");
      const section = "## Visible\nBody.\n";
      expect(splitSections(preamble + section)).toEqual({
        preamble,
        sections: [{ heading: "Visible", markdown: section }],
      });
    },
  );

  it("does not close a tilde fence with backticks", () => {
    const preamble = "~~~markdown\n```\n## Table 4: Code [S1 p.1]\n~~~\n";
    const section = "## Visible\nBody.\n";
    expect(splitSections(preamble + section)).toEqual({
      preamble,
      sections: [{ heading: "Visible", markdown: section }],
    });
  });

  it("does not open a backtick fence when its info string contains a backtick", () => {
    const preamble = "```java`script\n";
    const section = "## Table 4: Visible [S1 p.1]\nBody.\n";
    expect(splitSections(preamble + section)).toEqual({
      preamble,
      sections: [{ heading: "Table 4: Visible [S1 p.1]", markdown: section }],
    });
  });

  it.each(["``", "    ```"])("does not close a fence with a short or over-indented closer: %j", (closer) => {
    const preamble = ["```", closer, "## Hidden", "```", ""].join("\n");
    const section = "## Visible\n";
    expect(splitSections(preamble + section)).toEqual({
      preamble,
      sections: [{ heading: "Visible", markdown: section }],
    });
  });

  it.each([
    "",
    "Preamble only.\n",
    "## Single",
    "Before\n## One\n\n## Two\nAfter\n",
    "## One\n### Child\nBody\n## Two",
    "Intro\r\n## One  \r\nBody\r\n## Two\r\n",
    "```\n## Hidden\n```\n## Real\n~~~\n## Hidden too\n~~~\n",
    "## Real\n```\n## Unclosed code heading\n",
    "## Café 🧠\nTreatment: β blockers.\n## Next\n",
  ])("reconstructs the original markdown exactly: %j", (markdown) => {
    const { preamble, sections } = splitSections(markdown);
    expect(preamble + sections.map((section) => section.markdown).join("")).toBe(markdown);
  });
});

describe("balancedHalves", () => {
  it.each(["", "Introduction.\n### Detail", "Intro\n## Only\nBody.", "## Only\nBody."])(
    "returns the whole document for fewer than two sections: %j",
    (markdown) => {
      expect(balancedHalves(markdown)).toEqual([markdown]);
    },
  );

  it("chooses the minimum length difference across uneven sections of a long document", () => {
    const lengths = [900, 2000, 2200, 1500, 5700, 3900, 1000, 700, 1700, 2200, 1000, 1300, 1000];
    const sections = lengths.map((length, index) => {
      const heading = `## Section ${index + 1}\n`;
      return heading + "x".repeat(length - heading.length - 1) + "\n";
    });
    const preamble = "# Long study document\n\n";
    const markdown = preamble + sections.join("");
    let expectedK = 1;
    let minimumDifference = Infinity;

    for (let k = 1; k < sections.length; k++) {
      const half1 = preamble + sections.slice(0, k).join("");
      const half2 = sections.slice(k).join("");
      const difference = Math.abs(half1.length - half2.length);
      if (difference < minimumDifference) {
        minimumDifference = difference;
        expectedK = k;
      }
    }

    const halves = balancedHalves(markdown);
    expect(halves).toEqual([
      preamble + sections.slice(0, expectedK).join(""),
      sections.slice(expectedK).join(""),
    ]);
    expect(halves[0] + halves[1]).toBe(markdown);
    expect(Math.abs(halves[0].length - halves[1].length)).toBe(minimumDifference);
  });

  it("counts the preamble's length when choosing the boundary", () => {
    const sections = ["## A\n12345\n", "## B\n12345\n", "## C\n12345\n", "## D\n12345\n"];
    const preamble = "p".repeat(22) + "\n";
    const markdown = preamble + sections.join("");
    const halves = balancedHalves(markdown);
    expect(halves).toEqual([preamble + sections[0], sections.slice(1).join("")]);
    expect(halves.join("")).toBe(markdown);
  });

  it("chooses the smallest split index when length differences tie", () => {
    const sections = ["## A\na\n", "## B\nb\n", "## C\nc\n"];
    const markdown = sections.join("");
    expect(balancedHalves(markdown)).toEqual([sections[0], sections.slice(1).join("")]);
    expect(balancedHalves(markdown).join("")).toBe(markdown);
  });
});

describe("allocateItems", () => {
  it.each([0, 1, 2, 36, 60])("returns [%i] for a single half", (total) => {
    expect(allocateItems(total, ["Only half."])).toEqual([total]);
  });

  it("allocates 36 items over 10 and 8 distinct cited pages as 20 and 16", () => {
    const halves = [citedPages(10) + "\nRepeated. [S1 p.1]", citedPages(8)];
    expect(halves.map(citedPageCount)).toEqual([10, 8]);
    expect(allocateItems(36, halves)).toEqual([20, 16]);
  });

  it.each([18, 36])("reserves an item for each short section despite skewed page citations (total %i)", (total) => {
    const large = `## Large section\n${"Long factual content. ".repeat(500)}\n${citedPages(17)}\n`;
    const shortSections = Array.from(
      { length: 4 },
      (_, index) => `## Short section ${index + 1}\nFact. [S1 p.18]\n`,
    ).join("");
    const halves = balancedHalves(large + shortSections);

    expect(halves).toEqual([large, shortSections]);
    expect(halves.map(citedPageCount)).toEqual([17, 1]);
    const allocation = allocateItems(total, halves);
    expect(allocation).toEqual([total - 4, 4]);
    expect(allocation[1]).toBeGreaterThanOrEqual(4);
    expect(allocation[0] + allocation[1]).toBe(total);
    // The section floor also applies when the section-heavy half comes first.
    expect(allocateItems(total, [shortSections, large])).toEqual([4, total - 4]);
  });

  it.each([
    { total: 0, expected: [0, 0] },
    { total: 1, expected: [0, 1] },
    { total: 2, expected: [1, 1] },
    { total: 3, expected: [1, 2] },
    { total: 4, expected: [1, 3] },
  ])("allocates scarce items by section counts rather than citation weights: $total", ({ total, expected }) => {
    const first = `## Large\n${citedPages(17)}\n`;
    const second = Array.from({ length: 4 }, (_, index) => `## Short ${index}\nFact. [S1 p.18]\n`).join("");
    const allocation = allocateItems(total, [first, second]);
    expect(allocation).toEqual(expected);
    expect(allocation[0] + allocation[1]).toBe(total);
    if (total >= 2) expect(allocation.every((count) => count >= 1)).toBe(true);
  });

  it("rounds a scarce total proportionally across both section counts", () => {
    const first = Array.from({ length: 3 }, (_, index) => `## First ${index}\nFact. [S1 p.1]\n`).join("");
    const second = Array.from({ length: 5 }, (_, index) => `## Second ${index}\nFact. [S1 pp.2-18]\n`).join("");
    expect(allocateItems(7, [first, second])).toEqual([3, 4]);
  });

  it("does not count a non-empty preamble as an extra section", () => {
    const first = `Preamble. ${citedPages(17)}\n## Only section\nBody.\n`;
    const second = Array.from({ length: 4 }, (_, index) => `## Short ${index}\nFact. [S1 p.18]\n`).join("");
    expect(allocateItems(5, [first, second])).toEqual([1, 4]);
    expect(allocateItems(3, [first, second])).toEqual([1, 2]);
  });

  it("counts a non-empty half without section headings as one section", () => {
    const first = citedPages(17);
    const second = Array.from({ length: 4 }, (_, index) => `## Short ${index}\nFact. [S1 p.18]\n`).join("");
    expect(allocateItems(5, [first, second])).toEqual([1, 4]);
    expect(allocateItems(3, [first, second])).toEqual([1, 2]);
  });

  it("rounds the first share and assigns the remainder to the second", () => {
    expect(allocateItems(5, [citedPages(1), citedPages(1)])).toEqual([3, 2]);
  });

  it("uses length weights when neither half cites pages", () => {
    const halves = ["a".repeat(100), "b".repeat(300)];
    expect(halves.map(citedPageCount)).toEqual([0, 0]);
    expect(allocateItems(20, halves)).toEqual([5, 15]);
  });

  it.each([
    ["Uncited but non-empty.", citedPages(10)],
    [citedPages(10), "Uncited but non-empty."],
    ["x", "y".repeat(10_000)],
    ["x".repeat(10_000), "y"],
  ])("gives both non-empty halves at least one item when total is at least two", (first, second) => {
    for (const total of [2, 3, 5, 36, 60]) {
      const allocation = allocateItems(total, [first, second]);
      expect(allocation[0]).toBeGreaterThanOrEqual(1);
      expect(allocation[1]).toBeGreaterThanOrEqual(1);
      expect(allocation[0] + allocation[1]).toBe(total);
    }
  });

  it("does not reserve an item for a whitespace-only half", () => {
    expect(allocateItems(10, [" \n\t", citedPages(3)])).toEqual([0, 10]);
    expect(allocateItems(10, [citedPages(3), " \n\t"])).toEqual([10, 0]);
  });

  it.each([
    [citedPages(10), citedPages(8)],
    ["a", "b".repeat(1000)],
    ["", "Uncited content."],
    ["Uncited content.", ""],
    ["Uncited content.", citedPages(5)],
  ])("preserves every total, including zero and one", (first, second) => {
    for (const total of [0, 1, 2, 3, 7, 36, 60]) {
      const allocation = allocateItems(total, [first, second]);
      expect(allocation).toHaveLength(2);
      expect(allocation.every((count) => Number.isInteger(count) && count >= 0)).toBe(true);
      expect(allocation[0] + allocation[1]).toBe(total);
    }
  });
});
