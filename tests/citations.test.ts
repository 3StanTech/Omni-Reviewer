import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SourceViewerProvider } from "@/components/source-modal";
import { MarkdownBody } from "@/components/study-markdown";
import { UNSOURCED_INCOMPLETE_CHECK_TEXT, UnsourcedActionsProvider } from "@/components/unsourced-tag";

import {
  citationLabel,
  citationPattern,
  claimSentences,
  countClaims,
  dropUnknownSourceCitations,
  parseCitations,
  remarkCitations,
  citationSourcesForMode,
  resolveUnsourcedClaim,
  stripCitations,
  UNSOURCED_TOKEN,
  unsourcedTokenOffsets,
  type CitationSourceRef,
} from "@/lib/citations";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

async function toHast(markdown: string): Promise<HastNode> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: true })
    .use(remarkCitations)
    .use(remarkRehype);
  return (await processor.run(processor.parse(markdown))) as unknown as HastNode;
}

function findAll(node: HastNode, className: string): HastNode[] {
  const found: HastNode[] = [];
  const classes = node.properties?.className;
  if (Array.isArray(classes) && classes.includes(className)) found.push(node);
  for (const child of node.children ?? []) found.push(...findAll(child, className));
  return found;
}

function text(node: HastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(text).join("");
}

describe("citation grammar", () => {
  it("matches the page, range, and whole-source forms", () => {
    const matches = "A [S1 p.14] B [S1 pp.14-15] C [S2] D [S12 p.1000]".match(citationPattern());
    expect(matches).toEqual(["[S1 p.14]", "[S1 pp.14-15]", "[S2]", "[S12 p.1000]"]);
  });

  it("rejects timestamps, three-digit sources, lowercase, and loose spacing", () => {
    for (const raw of ["[S1 t.1:00]", "[S1 t.12:30]", "[S100]", "[s1]", "[S1  p.2]", "[S1 p.]", "[S 1]"]) {
      expect(raw.match(citationPattern())).toBeNull();
    }
  });

  it("returns a fresh global pattern on each call", () => {
    const first = citationPattern();
    first.exec("[S1]");
    expect(citationPattern().lastIndex).toBe(0);
  });
});

describe("citation helpers", () => {
  it("parses sources and pages with offsets", () => {
    expect(parseCitations("x [S1 p.14] y [S2 pp.3-5] z [S3]")).toEqual([
      { raw: "[S1 p.14]", source: 1, pageStart: 14, pageEnd: 14, index: 2 },
      { raw: "[S2 pp.3-5]", source: 2, pageStart: 3, pageEnd: 5, index: 14 },
      { raw: "[S3]", source: 3, pageStart: null, pageEnd: null, index: 28 },
    ]);
  });

  it("reads a single-p range as a range", () => {
    expect("x [S1 p.9-10] y [S1 p.2, p.10-11]".match(citationPattern())).toEqual(["[S1 p.9-10]", "[S1 p.2, p.10-11]"]);
    expect(parseCitations("[S1 p.9-10]")[0]).toMatchObject({ pageStart: 9, pageEnd: 10 });
    expect(parseCitations("[S1 p.2, p.10-11]").map((c) => [c.pageStart, c.pageEnd])).toEqual([[2, 2], [10, 11]]);
  });

  it("collapses a reversed range to its start page", () => {
    expect(parseCitations("[S1 pp.9-4]")[0]).toMatchObject({ pageStart: 9, pageEnd: 9 });
  });

  it("labels chips", () => {
    expect(citationLabel({ source: 1, pageStart: 14, pageEnd: 14 })).toBe("p.14");
    expect(citationLabel({ source: 1, pageStart: 14, pageEnd: 15 })).toBe("pp.14-15");
    expect(citationLabel({ source: 2, pageStart: null, pageEnd: null })).toBe("S2");
  });

  it("strips citations and the unsourced token", () => {
    expect(stripCitations(`Water boils at 100 C [S1 p.2]. Ice floats ${UNSOURCED_TOKEN}.`)).toBe(
      "Water boils at 100 C. Ice floats.",
    );
  });

  it("drops citations to sources outside the pack", () => {
    expect(dropUnknownSourceCitations("A [S1 p.2] B [S3] C [S0]", 2)).toBe("A [S1 p.2] B  C ");
  });
});

describe("claimSentences", () => {
  it("splits prose and keeps trailing citations with their sentence", () => {
    const markdown = "Cells divide by mitosis [S1 p.4]. Meiosis halves chromosomes. [S2] Done here! [[unsourced]]";
    const claims = claimSentences(markdown);
    expect(claims.map((claim) => claim.text)).toEqual([
      "Cells divide by mitosis [S1 p.4].",
      "Meiosis halves chromosomes. [S2]",
      "Done here! [[unsourced]]",
    ]);
    for (const claim of claims) expect(markdown.slice(claim.start, claim.end)).toBe(claim.text);
  });

  it("ignores headings, fenced code, math, and table header rows", () => {
    const markdown = [
      "# Heading that is long enough to count. Really.",
      "",
      "```ts",
      "const a = 1. Not a claim.",
      "```",
      "",
      "$$",
      "x = 1. y = 2.",
      "$$",
      "",
      "Use `a. b` and $x. y$ in one sentence [S1].",
      "",
      "| Term | Meaning |",
      "| --- | --- |",
      "| Osmosis | Water crosses a membrane [S1 p.9] |",
      "| Diffusion | Solutes spread out |",
      "",
      "- First item claim. Second item claim.",
      "- Third item",
    ].join("\n");
    const claims = claimSentences(markdown);
    expect(claims.map((claim) => claim.text)).toEqual([
      "Use `a. b` and $x. y$ in one sentence [S1].",
      "Osmosis | Water crosses a membrane [S1 p.9]",
      "Diffusion | Solutes spread out",
      "First item claim.",
      "Second item claim.",
      "Third item",
    ]);
    for (const claim of claims) expect(markdown.slice(claim.start, claim.end)).toBe(claim.text);
  });

  it("joins wrapped paragraph lines into one sentence", () => {
    const claims = claimSentences("The heart has four\nchambers in mammals. Next one.");
    expect(claims.map((claim) => claim.text)).toEqual(["The heart has four\nchambers in mammals.", "Next one."]);
  });
});

describe("countClaims", () => {
  it("counts claims of six or more words, cited ones, and unsourced ones", () => {
    const markdown = [
      "Photosynthesis converts light into chemical energy [S1 p.3].",
      "Chlorophyll absorbs mostly red and blue light. [[unsourced]]",
      "Short one [S1].",
      "Plants release oxygen as a by-product of photosynthesis.",
      "",
      "```",
      "This code line has more than six words in it.",
      "```",
    ].join("\n");
    expect(countClaims(markdown)).toEqual({ total: 3, cited: 1, unsourced: 1 });
  });

  it("returns zeros for empty input", () => {
    expect(countClaims("")).toEqual({ total: 0, cited: 0, unsourced: 0 });
  });
});

describe("comma page lists", () => {
  it("parses one citation per page or range in a list", () => {
    const parsed = parseCitations("Both [S1 p.2, p.3] and [S2 pp.4-5,p.9].");
    expect(parsed.map((c) => [c.source, c.pageStart, c.pageEnd])).toEqual([
      [1, 2, 2], [1, 3, 3], [2, 4, 5], [2, 9, 9],
    ]);
    expect(stripCitations("Both [S1 p.2, p.3].")).toBe("Both.");
  });
});

describe("remarkCitations", () => {
  it("turns citations into skip-marked chips with source and page data", async () => {
    const tree = await toHast("Mitosis has four phases [S1 pp.14-15]. See also [S2] and [S3 p.7].");
    const chips = findAll(tree, "study-cite");
    expect(chips).toHaveLength(3);
    expect(chips[0]).toMatchObject({
      tagName: "span",
      properties: {
        className: ["study-cite"],
        dataCiteSource: "1",
        dataCitePageStart: "14",
        dataCitePageEnd: "15",
        dataStudySkip: "",
      },
    });
    expect(text(chips[0])).toBe("pp.14-15");
    expect(chips[1].properties).toEqual({ className: ["study-cite"], dataCiteSource: "2", dataStudySkip: "" });
    expect(text(chips[1])).toBe("S2");
    expect(chips[2].properties).toMatchObject({ dataCitePageStart: "7", dataCitePageEnd: "7" });
    expect(text(tree)).toBe("Mitosis has four phases pp.14-15. See also S2 and p.7.");
  });

  it("leaves code and math untouched", async () => {
    const tree = await toHast(
      "Inline `[S1 p.2]` and $[S2]$ stay.\n\n```\n[S3] [[unsourced]]\n```\n\n$$\n[S4]\n$$",
    );
    expect(findAll(tree, "study-cite")).toHaveLength(0);
    expect(findAll(tree, "study-unsourced")).toHaveLength(0);
    const rendered = text(tree);
    for (const raw of ["[S1 p.2]", "[S2]", "[S3] [[unsourced]]", "[S4]"]) expect(rendered).toContain(raw);
  });

  it("wraps a sentence that ends with its citation before the unsourced token", async () => {
    const tree = await toHast(
      "Macrolides bind the 50S subunit [S1 p.3]. This binding halts bacterial growth [S1 p.3]. [[unsourced]]",
    );
    const [claim] = findAll(tree, "study-claim");
    expect(claim).toBeDefined();
    expect(text(claim)).toBe("This binding halts bacterial growth p.3.");
    expect(findAll(claim, "study-cite")).toHaveLength(1);
  });

  it("marks an unsourced token and wraps the plain sentence before it", async () => {
    const tree = await toHast("Cells divide [S1 p.2]. The nucleus stores lipids. [[unsourced]] Next claim.");
    const [marker] = findAll(tree, "study-unsourced");
    expect(marker).toMatchObject({
      tagName: "span",
      properties: { className: ["study-unsourced"], dataUnsourced: "", dataStudySkip: "" },
      children: [],
    });
    const [claim] = findAll(tree, "study-claim");
    expect(claim.properties).toEqual({ className: ["study-claim"], dataClaim: "unsourced" });
    expect(text(claim)).toBe("The nucleus stores lipids.");
    expect(text(tree)).toBe("Cells divide p.2. The nucleus stores lipids.  Next claim.");
  });

  it("wraps a sentence at the start of a paragraph and across formatting", async () => {
    const tree = await toHast("Enzymes are **always** proteins [[unsourced]].");
    const [claim] = findAll(tree, "study-claim");
    expect(text(claim)).toBe("Enzymes are always proteins");
    expect(claim.children?.some((child) => child.tagName === "strong")).toBe(true);
  });

  it("stops the claim at a previous citation chip", async () => {
    const tree = await toHast("First fact [S1] second fact here [[unsourced]]");
    const [claim] = findAll(tree, "study-claim");
    expect(text(claim)).toBe("second fact here");
  });

  it("skips the wrapper when a sentence boundary sits inside formatting", async () => {
    const tree = await toHast("**One fact. Two fact** [[unsourced]]");
    expect(findAll(tree, "study-claim")).toHaveLength(0);
    expect(findAll(tree, "study-unsourced")).toHaveLength(1);
  });

  it("handles citations in list items and table cells", async () => {
    const tree = await toHast("- Item [S1 p.1]\n\n| A | B |\n| - | - |\n| x | y [S2] |");
    expect(findAll(tree, "study-cite")).toHaveLength(2);
  });
});

describe("unsourced Keep and Delete sentence transforms", () => {
  it("finds rendered tokens in order and ignores code and math", () => {
    const markdown = "Real one. [[unsourced]] `[[unsourced]]` $[[unsourced]]$\n\n```\n[[unsourced]]\n```\n\nReal two [[unsourced]].";
    const offsets = unsourcedTokenOffsets(markdown);
    expect(offsets).toHaveLength(2);
    for (const at of offsets) expect(markdown.slice(at, at + UNSOURCED_TOKEN.length)).toBe(UNSOURCED_TOKEN);
    expect(offsets[1]).toBe(markdown.lastIndexOf(UNSOURCED_TOKEN));
  });

  it("Keep removes only the token and its gap", () => {
    const markdown = "Cells divide [S1 p.2]. The nucleus stores lipids. [[unsourced]] Next claim.";
    expect(resolveUnsourcedClaim(markdown, 0, "keep")).toBe("Cells divide [S1 p.2]. The nucleus stores lipids. Next claim.");
    expect(resolveUnsourcedClaim("Enzymes are **always** proteins [[unsourced]].", 0, "keep")).toBe("Enzymes are **always** proteins.");
  });

  it("Delete sentence removes the claim that carries the token", () => {
    const markdown = "Cells divide [S1 p.2]. The nucleus stores lipids. [[unsourced]] Next claim.";
    expect(resolveUnsourcedClaim(markdown, 0, "delete")).toBe("Cells divide [S1 p.2]. Next claim.");
    expect(resolveUnsourcedClaim("- Claim one. [[unsourced]] Claim two.\n- Other [S1].", 0, "delete")).toBe("- Claim two.\n- Other [S1].");
  });

  it("drops a paragraph or table row that the deletion empties", () => {
    expect(resolveUnsourcedClaim("Para one [S1].\n\nOnly bad claim here. [[unsourced]]\n\nPara three.", 0, "delete"))
      .toBe("Para one [S1].\n\nPara three.");
    expect(resolveUnsourcedClaim("| A | B |\n| - | - |\n| x | y [[unsourced]] |\n| z | w |", 0, "delete"))
      .toBe("| A | B |\n| - | - |\n| z | w |");
  });

  it("targets the nth token and returns null for a missing one", () => {
    const markdown = "First odd claim. [[unsourced]] Second odd claim. [[unsourced]]";
    expect(resolveUnsourcedClaim(markdown, 1, "delete")).toBe("First odd claim. [[unsourced]]");
    expect(resolveUnsourcedClaim(markdown, 0, "keep")).toBe("First odd claim. Second odd claim. [[unsourced]]");
    expect(resolveUnsourcedClaim(markdown, 2, "keep")).toBeNull();
  });
});

describe("citation chips through the study Markdown renderer", () => {
  const sources: CitationSourceRef[] = [
    { index: 1, sourceId: "src-1", filename: "Lecture.pdf", hasPages: true },
  ];
  const markdown = "Aminoglycosides bind the 30S subunit. [S1 p.14] Once-daily dosing is common. [[unsourced]]";

  function render(citationSources: CitationSourceRef[] | null, inline = false): string {
    return renderToStaticMarkup(
      createElement(SourceViewerProvider, { reviewerId: "rev-1", citationSources }, createElement(MarkdownBody, { source: markdown, inline })),
    );
  }

  it("renders chips as labelled buttons and the unsourced tag after its claim", () => {
    const html = render(sources);
    expect(html).toMatch(/<button type="button" data-study-skip="" aria-label="Open source page 14" class="study-cite[^"]*"[^>]*>p\.14<\/button>/);
    expect(html).toMatch(/<span class="study-claim[^"]*" data-claim="unsourced">Once-daily dosing is common\.<\/span>/);
    expect(html).toMatch(/<span data-study-skip="" class="study-unsourced[^"]*">/);
    expect(html).toContain("Not from your uploaded sources");
    expect(html).not.toContain("[S1 p.14]");
    expect(html).not.toContain(UNSOURCED_TOKEN);
  });

  it("numbers unsourced tags through the sanitizer so Keep and Delete sentence can act", () => {
    const withActions = renderToStaticMarkup(
      createElement(
        UnsourcedActionsProvider,
        { value: { resolve: async () => true, disabled: false } },
        createElement(MarkdownBody, { source: markdown }),
      ),
    );
    expect(withActions).toContain(">Keep</button>");
    expect(withActions).toContain(">Delete sentence</button>");
    expect(render(sources)).not.toContain("Delete sentence");
  });

  it("renders inert chips when the source list is unavailable or inside a control", () => {
    for (const html of [render(null), render(sources, true)]) {
      expect(html).toMatch(/<span data-study-skip="" class="study-cite[^"]*">p\.14<\/span>/);
      expect(html).not.toContain("Open source page 14");
    }
    expect(render(sources, true)).not.toMatch(/<button/);
  });
});

describe("review repairs", () => {
  it("deletes only the sentence when a pipe sits in inline math or code", () => {
    const math = "Bayes gives the rule. The posterior is $P(A|B)$ here. [[unsourced]] Next fact.";
    expect(resolveUnsourcedClaim(math, 0, "delete")).toBe("Bayes gives the rule. Next fact.");
    const code = "Pipes join commands. Run `ls | wc` to count. [[unsourced]] Next fact.";
    expect(resolveUnsourcedClaim(code, 0, "delete")).toBe("Pipes join commands. Next fact.");
    const table = "| A | B |\n| - | - |\n| x | y [[unsourced]] |\n| z | w |";
    expect(resolveUnsourcedClaim(table, 0, "delete")).toBe("| A | B |\n| - | - |\n| z | w |");
    expect(claimSentences(table).map((claim) => claim.kind)).toEqual(["tableRow", "tableRow"]);
    expect(claimSentences(math).every((claim) => claim.kind === "prose")).toBe(true);
  });

  it("does not split at a genus initial but still ends at a lone capital", () => {
    const markdown = "Cephalexin misses *H. influenzae* [S1 p.3]. E. coli is covered [S1 p.4]. Vaccinate for Hepatitis B. Patients need two doses [S1 p.5].";
    expect(claimSentences(markdown).map((claim) => claim.text)).toEqual([
      "Cephalexin misses *H. influenzae* [S1 p.3].",
      "E. coli is covered [S1 p.4].",
      "Vaccinate for Hepatitis B.",
      "Patients need two doses [S1 p.5].",
    ]);
  });

  it("does not split sentences at abbreviations", () => {
    const markdown = "Pain relief uses NSAIDs, e.g. ibuprofen, for mild cases. [[unsourced]] Rest helps [S1 p.2].";
    expect(claimSentences(markdown).map((claim) => claim.text)).toEqual([
      "Pain relief uses NSAIDs, e.g. ibuprofen, for mild cases. [[unsourced]]",
      "Rest helps [S1 p.2].",
    ]);
    expect(resolveUnsourcedClaim(markdown, 0, "delete")).toBe("Rest helps [S1 p.2].");
    expect(claimSentences("See Fig. 3 for detail. Vitamin C. Next.").map((claim) => claim.text)).toEqual([
      "See Fig. 3 for detail.",
      "Vitamin C.",
      "Next.",
    ]);
  });

  it("resolves each mode against its own generation's source list", () => {
    const oldRefs: CitationSourceRef[] = [{ index: 1, sourceId: "old", filename: "Old.pdf", hasPages: true }];
    const newRefs: CitationSourceRef[] = [{ index: 1, sourceId: "new", filename: "New.pdf", hasPages: true }];
    const views = {
      locked_in: { contentJson: { citationSources: newRefs }, generationRunId: "run-2" },
      summary: { contentJson: { citationSources: oldRefs }, generationRunId: "run-1" },
      test_me: { contentJson: [], generationRunId: "run-1" },
      carded: { contentJson: [], generationRunId: "run-0" },
      staleKinds: ["summary", "test_me", "carded"],
    };
    expect(citationSourcesForMode(views, "locked_in")).toEqual(newRefs);
    expect(citationSourcesForMode(views, "summary")).toEqual(oldRefs);
    expect(citationSourcesForMode(views, "test_me")).toEqual(oldRefs);
    expect(citationSourcesForMode(views, "carded")).toBeNull();
    expect(citationSourcesForMode({ ...views, summary: { contentJson: null, generationRunId: "run-1" } }, "summary")).toBeNull();
    expect(citationSourcesForMode({ ...views, staleKinds: [] }, "carded")).toEqual(newRefs);
  });

  it("softens the unsourced explanation when the grounding check was incomplete", () => {
    const html = (checkIncomplete: boolean) => renderToStaticMarkup(
      createElement(
        UnsourcedActionsProvider,
        { value: { resolve: async () => true, disabled: false, checkIncomplete } },
        createElement(MarkdownBody, { source: "Once-daily dosing is common. [[unsourced]]" }),
      ),
    );
    expect(html(true)).toContain(UNSOURCED_INCOMPLETE_CHECK_TEXT);
    expect(html(true)).not.toContain("searched every page");
    expect(html(false)).toContain("searched every page");
    expect(UNSOURCED_INCOMPLETE_CHECK_TEXT).not.toContain("\u2014");
  });
});

describe("isUnsourcedMarkerOnlyChange", () => {
  it("is true when Keep only removes an unsourced marker", async () => {
    const { isUnsourcedMarkerOnlyChange } = await import("@/lib/citations");
    const before = "Beta-lactams bind PBPs [S1 p.4]. They are safe in pregnancy. [[unsourced]]\n\nNext.";
    const after = "Beta-lactams bind PBPs [S1 p.4]. They are safe in pregnancy.\n\nNext.";
    expect(isUnsourcedMarkerOnlyChange(before, after)).toBe(true);
  });

  it("is false for Delete sentence, other edits, adding a marker, or no change", async () => {
    const { isUnsourcedMarkerOnlyChange } = await import("@/lib/citations");
    const before = "Beta-lactams bind PBPs [S1 p.4]. They are safe in pregnancy. [[unsourced]]";
    expect(isUnsourcedMarkerOnlyChange(before, "Beta-lactams bind PBPs [S1 p.4].")).toBe(false);
    expect(isUnsourcedMarkerOnlyChange(before, before.replace("safe", "unsafe").replace(" [[unsourced]]", ""))).toBe(false);
    expect(isUnsourcedMarkerOnlyChange("A claim here.", "A claim here. [[unsourced]]")).toBe(false);
    expect(isUnsourcedMarkerOnlyChange(before, before)).toBe(false);
  });
});
