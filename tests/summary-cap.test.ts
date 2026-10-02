import { describe, expect, it } from "vitest";

import { capSummarySections } from "@/lib/summary-cap";

describe("capSummarySections", () => {
  it("keeps the first N list items with their nested children and continuations, dropping later item blocks", () => {
    const first = ["- First parent. [S1 p.1]", "    - Nested child.", "    Continued detail for the first parent."];
    const second = ["- Second parent.", "    1. Nested numbered child.", "    More second-parent detail."];
    const dropped = ["- Third parent.", "    - This child must go with the third parent.", "    This continuation must also go."];
    const tail = ["", "### Relationships", "", "A standalone paragraph stays.", ""];
    const input = ["## Mechanisms", "", ...first, ...second, ...dropped, ...tail].join("\n");
    const expected = ["## Mechanisms", "", ...first, ...second, ...tail].join("\n");
    expect(capSummarySections(input, [{ heading: "Mechanisms", bullets: 2 }])).toBe(expected);
  });

  it("caps each section independently and counts list items across paragraphs and subheadings", () => {
    const input = [
      "## First", "- First kept.", "", "A paragraph stays.", "### Details", "- Second dropped.", "",
      "## Second", "- Second-section first kept.", "- Second-section second kept.", "- Second-section third dropped.",
    ].join("\n");
    const expected = [
      "## First", "- First kept.", "", "A paragraph stays.", "### Details", "",
      "## Second", "- Second-section first kept.", "- Second-section second kept.",
    ].join("\n");
    expect(capSummarySections(input, [{ heading: "First", bullets: 1 }, { heading: "Second", bullets: 2 }])).toBe(expected);
  });

  it("caps numbered lists while keeping each retained item's children and continuation", () => {
    const input = [
      "## Sequence", "1. First step.", "    Detail for step one.", "2. Second step.", "    - Child of step two.",
      "3. Third step.", "    Detail for dropped step three.", "4. Fourth step.", "", "The closing paragraph stays.",
    ].join("\n");
    const expected = [
      "## Sequence", "1. First step.", "    Detail for step one.", "2. Second step.", "    - Child of step two.",
      "", "The closing paragraph stays.",
    ].join("\n");
    expect(capSummarySections(input, [{ heading: "Sequence", bullets: 2 }])).toBe(expected);
  });

  it.each(["-", "*", "+", "1."])("recognizes %s top-level list items with up to three leading spaces", (marker) => {
    for (const spaces of [0, 1, 2, 3]) {
      const lines = Array.from({ length: 3 }, (_, i) => `${" ".repeat(spaces)}${marker} Item ${i + 1}.`);
      expect(capSummarySections(["## Indentation", ...lines].join("\n"), [{ heading: "Indentation", bullets: 2 }]))
        .toBe(["## Indentation", ...lines.slice(0, 2)].join("\n"));
    }
  });

  function table(leadingPipes: boolean, rows = 10) {
    const row = (text: string) => leadingPipes ? `| ${text} |` : text;
    return [row("Drug | Mechanism"), row(":--- | ---:"), ...Array.from({ length: rows }, (_, i) => row(`Drug ${i + 1} | Action ${i + 1}. [S1 p.1]`))];
  }

  it.each([true, false])("keeps a ten-row table's header, delimiter and first six data rows (leading pipes: %s)", (leadingPipes) => {
    const lines = table(leadingPipes);
    const input = ["## Drugs", "", ...lines, "", "### Adverse effects", "", "A paragraph stays."].join("\n");
    const expected = ["## Drugs", "", ...lines.slice(0, 8), "", "### Adverse effects", "", "A paragraph stays."].join("\n");
    expect(capSummarySections(input, [{ heading: "Drugs", bullets: 2 }])).toBe(expected);
  });

  it("caps every table separately within one section", () => {
    const first = table(true);
    const second = table(false);
    const input = ["## Drugs", ...first, "", "### Comparison", "", ...second].join("\n");
    const expected = ["## Drugs", ...first.slice(0, 8), "", "### Comparison", "", ...second.slice(0, 8)].join("\n");
    expect(capSummarySections(input, [{ heading: "Drugs", bullets: 2 }])).toBe(expected);
  });

  it("honors an explicit maxTableRows without spending the section's list-item allowance", () => {
    const lines = table(true);
    const input = ["## Drugs", ...lines, "", "- Kept bullet.", "- Dropped bullet."].join("\n");
    const expected = ["## Drugs", ...lines.slice(0, 4), "", "- Kept bullet."].join("\n");
    expect(capSummarySections(input, [{ heading: "Drugs", bullets: 1 }], 2)).toBe(expected);
  });

  it("keeps pipe-containing prose that is not followed by a table delimiter", () => {
    const input = "## Mechanisms\n\nLabel | Mechanism\nA plain paragraph follows.\nThis line | stays too.";
    expect(capSummarySections(input, [{ heading: "Mechanisms", bullets: 1 }])).toBe(input);
  });

  it.each([
    ["  DRUG   mechanisms [S1 p.2] [[unsourced]]", "drug mechanisms"],
    ["Drug mechanisms", "  DRUG   mechanisms [S2 pp.3-4] [[unsourced]]"],
  ])("matches normalized section heading %s to limit heading %s without altering the heading", (heading, limitHeading) => {
    const kept = `## ${heading}\n\n- Kept fact. [S1 p.2]`;
    const input = `${kept}\n- Dropped fact.`;
    expect(capSummarySections(input, [{ heading: limitHeading, bullets: 1 }])).toBe(kept);
  });

  it("uses fourteen items for an unmatched section and still keeps later headings", () => {
    const items = Array.from({ length: 16 }, (_, i) => `- Unmatched item ${i + 1}.`);
    const input = ["## Unmatched", ...items, "", "## Known", "- Known retained.", "- Known dropped."].join("\n");
    const expected = ["## Unmatched", ...items.slice(0, 14), "", "## Known", "- Known retained."].join("\n");
    expect(capSummarySections(input, [{ heading: "Known", bullets: 1 }])).toBe(expected);
  });

  it.each(["```", "~~~~"])("keeps %s fenced code byte-identical without counting its headings, bullets or table rows", (fence) => {
    const code = [fence + "md", "## Fake section", ...Array.from({ length: 16 }, (_, i) => `- Code bullet ${i + 1}.`), ...table(false), fence];
    const input = ["## Actual", "- First kept.", ...code, "- Second dropped.", "", "## Later", "- Later kept."].join("\n");
    const expected = ["## Actual", "- First kept.", ...code, "", "## Later", "- Later kept."].join("\n");
    expect(capSummarySections(input, [{ heading: "Actual", bullets: 1 }, { heading: "Later", bullets: 1 }])).toBe(expected);
  });

  it("keeps the preamble including its paragraphs, lists and tables", () => {
    const preamble = ["# Summary", "", "Preamble  spacing stays.  ", ...Array.from({ length: 16 }, (_, i) => `- Preamble item ${i + 1}.`), "", ...table(false), ""].join("\n");
    const input = `${preamble}\n## Content\n- Kept content.\n- Dropped content.`;
    const expected = `${preamble}\n## Content\n- Kept content.`;
    expect(capSummarySections(input, [{ heading: "Content", bullets: 1 }])).toBe(expected);
    expect(capSummarySections(preamble, [])).toBe(preamble);
  });

  it("keeps every retained line byte-identical, including blank lines, tabs and hard breaks", () => {
    const kept = [
      "##  Mechanisms [S1 p.2]  ", "", "A  paragraph with\tspacing.  ", "### Details  ", "",
      "- **Kept**  fact. [S1 p.2]  ", "    Continuation\twith  spacing.  ", "",
    ];
    const tail = ["", "A closing  paragraph.  ", ""];
    const input = [...kept, "- Dropped fact.", "    Dropped child.", ...tail].join("\n");
    expect(capSummarySections(input, [{ heading: "mechanisms", bullets: 1 }]))
      .toBe([...kept, ...tail].join("\n"));
  });

  it("returns a document under its limits byte-identically", () => {
    const input = "# Summary\n\nIntro.\n\n## Facts\n\n- First fact.  \n\n### Details\n\nA paragraph.\n";
    expect(capSummarySections(input, [{ heading: "Facts", bullets: 2 }])).toBe(input);
    expect(capSummarySections("", [])).toBe("");
  });
});
