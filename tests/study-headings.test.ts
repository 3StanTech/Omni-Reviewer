import { describe, expect, it } from "vitest";

import { sanitizeStudyHeadings } from "@/lib/study-headings";

describe("sanitizeStudyHeadings", () => {
  it.each([
    ["### Table 1.1: Antibiotic vs. Antimicrobial [S1 p.1, p.2]", "### Table: Antibiotic vs. Antimicrobial"],
    ["#### Figure 3. Cell wall", "#### Figure: Cell wall"],
    ["### Table 2 - Sources", "### Table: Sources"],
    ["## II. Definition of Terms [S1 p.1]", "## II. Definition of Terms"],
    ["## Tables of Drugs", "## Tables of Drugs"],
    ["### table 4: x", "### table: x"],
  ])("sanitizes the contract example %j", (markdown, expected) => {
    expect(sanitizeStudyHeadings(markdown)).toBe(expected);
  });

  it.each([1, 2, 3, 4, 5, 6])("sanitizes ATX headings at level %i", (level) => {
    const prefix = "#".repeat(level);
    expect(sanitizeStudyHeadings(`${prefix} Table 4: Topic [S1 p.1] [[unsourced]]`)).toBe(
      `${prefix} Table: Topic`,
    );
  });

  it("removes multiple citations, comma page lists and unsourced tokens from headings", () => {
    expect(sanitizeStudyHeadings("## Topic [S1 p.1, p.2] [S2] [[unsourced]]  ")).toBe("## Topic");
    expect(sanitizeStudyHeadings("## [[unsourced]] Topic [[unsourced]]")).toBe("## Topic");
  });

  it("collapses runs of spaces and trims the end of headings", () => {
    expect(sanitizeStudyHeadings("###   Table 2:   Drug   classes [S1 p.2]   ")).toBe(
      "### Table: Drug classes",
    );
  });

  it.each([
    ["## Table 1.2.3: Classes", "## Table: Classes"],
    ["## Figure 3 – Mechanism", "## Figure: Mechanism"],
    ["## FIGURE 12 — Mechanism", "## FIGURE: Mechanism"],
    ["## table 4. Sources", "## table: Sources"],
    ["## figure 5-Pathway", "## figure: Pathway"],
  ])("normalizes numbering and keeps the original word casing: %j", (markdown, expected) => {
    expect(sanitizeStudyHeadings(markdown)).toBe(expected);
  });

  it("only rewrites numbering at the start of heading text", () => {
    const markdown = "## See Table 4: Drug classes\n### Table 4 drug classes\n## Figurehead 3: Topic";
    expect(sanitizeStudyHeadings(markdown)).toBe(markdown);
  });

  it("preserves body lines, their citations, spacing and unsourced tokens byte for byte", () => {
    const body = [
      "Body  fact. [S1 p.1, p.2] [S2] [[unsourced]]  ",
      "Table 4:  Body label [S1 p.3]",
      "- List item. [S2] [[unsourced]]",
      "| Drug | Dose [S1 p.2] |",
      "\tIndented body. [S1 p.4]\t",
      "",
    ].join("\n");
    expect(sanitizeStudyHeadings(`## Topic [S1 p.1]\n${body}`)).toBe(`## Topic\n${body}`);
  });

  it.each(["```", "~~~"])("preserves all lines inside %s fenced code", (fence) => {
    const code = [
      `${fence}markdown`,
      "## Table 4:  Code [S1 p.1] [[unsourced]]  ",
      "###### Figure 2. Code [S2]",
      "Body  [S1 p.1, p.2] [[unsourced]]",
      fence,
    ].join("\n");
    const markdown = `## Before [S1 p.1]\n${code}\n## After [S2]\n`;
    expect(sanitizeStudyHeadings(markdown)).toBe(`## Before\n${code}\n## After\n`);
  });

  it("leaves headings inside an unclosed fence untouched", () => {
    const markdown = "```markdown\n## Table 4: Code [S1 p.1] [[unsourced]]\n";
    expect(sanitizeStudyHeadings(markdown)).toBe(markdown);
  });

  it("does not close a backtick fence when a fence-looking line has an info string", () => {
    const code = "```\n```javascript\n## Table 4: Code [S1 p.1]\n```\n";
    expect(sanitizeStudyHeadings(code + "## Table 5: Visible [S1 p.2]\n")).toBe(
      code + "## Table: Visible\n",
    );
  });

  it.each(["```   ", "``` \t", "   ```` \t"])(
    "closes a backtick fence with a bare closer and trailing whitespace: %j",
    (closer) => {
      const code = ["```javascript", "## Table 4: Code [S1 p.1]", closer, ""].join("\n");
      expect(sanitizeStudyHeadings(code + "## Table 5: Visible [S1 p.2]\n")).toBe(
        code + "## Table: Visible\n",
      );
    },
  );

  it("does not close a tilde fence with backticks", () => {
    const code = "~~~markdown\n```\n## Table 4: Code [S1 p.1]\n~~~\n";
    expect(sanitizeStudyHeadings(code + "## Table 5: Visible [S1 p.2]\n")).toBe(
      code + "## Table: Visible\n",
    );
  });

  it("does not open a backtick fence when its info string contains a backtick", () => {
    expect(sanitizeStudyHeadings("```java`script\n## Table 4: Visible [S1 p.1]\n")).toBe(
      "```java`script\n## Table: Visible\n",
    );
  });

  it.each(["``", "    ```"])("does not close a fence with a short or over-indented closer: %j", (closer) => {
    const code = ["```", closer, "## Table 4: Code [S1 p.1]", "```", ""].join("\n");
    expect(sanitizeStudyHeadings(code + "## Table 5: Visible [S1 p.2]\n")).toBe(
      code + "## Table: Visible\n",
    );
  });

  it("does not sanitize lines outside the ATX level 1 through 6 contract", () => {
    const markdown = [
      "####### Table 4: Seven hashes [S1 p.1]",
      "##No space [S2]",
      " ## Indented heading [S1 p.2]",
      "> ## Quoted heading [S2]",
      "Setext title [S1 p.3]",
      "=======================",
    ].join("\n");
    expect(sanitizeStudyHeadings(markdown)).toBe(markdown);
  });

  it.each(["", "Body only. [S1 p.1] [[unsourced]]\n", "## Topic\nBody.\n"])(
    "preserves already clean input: %j",
    (markdown) => {
      expect(sanitizeStudyHeadings(markdown)).toBe(markdown);
    },
  );
});
