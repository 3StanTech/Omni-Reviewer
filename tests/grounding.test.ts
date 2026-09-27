import { describe, expect, it, vi } from "vitest";
import {
  groundDocument,
  keyTerms,
  LEXICAL_SUPPORT_THRESHOLD,
  lexicalSupport,
  normalizeForMatch,
  type GroundingSource,
  type VerifyFn,
} from "@/lib/grounding";

const PHARM_SOURCE: GroundingSource = {
  index: 1,
  text: [
    "<<<page 13>>>",
    "",
    "Beta-lactams inhibit cell wall synthesis by binding penicillin-binding proteins.",
    "",
    "<<<page 14>>>",
    "",
    "Aminoglycosides such as gentamicin bind the 30S ribosomal subunit, causing misreading of mRNA and bactericidal activity.",
    "",
    "<<<page 15>>>",
    "",
    "Macrolides bind the 50S ribosomal subunit and block translocation during protein synthesis.",
  ].join("\n"),
};

const HISTORY_SOURCE: GroundingSource = {
  index: 2,
  text: "The treaty of Westphalia ended the Thirty Years War in 1648 and reshaped European sovereignty.",
};

const SUPPORTED = "Aminoglycosides bind the 30S ribosomal subunit and cause mRNA misreading. [S1 p.14]";
const INVENTED = "Gentamicin is dosed at 250 mg every hour for twelve consecutive weeks. [S1 p.14]";

function neverCalled(): VerifyFn {
  return vi.fn<VerifyFn>(async () => {
    throw new Error("verify should not be called");
  });
}

function rejectAll(): VerifyFn {
  return vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: false })));
}

describe("lexical helpers", () => {
  it("normalizes case, diacritics, citations, and stopwords", () => {
    expect(normalizeForMatch("The **Café** binds [S1 p.2] the RNA. [[unsourced]]")).toBe("cafe binds rna");
  });

  it("extracts names, numbers with units, and long words", () => {
    const terms = keyTerms("Aminoglycosides bind the 30S subunit at 5 mg with Gentamicin.");
    expect(terms).toEqual(expect.arrayContaining(["aminoglycosides", "30s", "subunit", "5 mg", "gentamicin"]));
    expect(terms).not.toContain("bind");
  });

  it("scores the pharmacology page above the threshold and an invented dose below it", () => {
    const page14 = PHARM_SOURCE.text.split("<<<page 14>>>")[1].split("<<<page 15>>>")[0];
    expect(lexicalSupport(SUPPORTED, page14)).toBeGreaterThanOrEqual(LEXICAL_SUPPORT_THRESHOLD);
    expect(lexicalSupport(INVENTED, page14)).toBeLessThan(LEXICAL_SUPPORT_THRESHOLD);
    expect(lexicalSupport("anything", "")).toBe(0);
  });
});

describe("groundDocument", () => {
  it("accepts lexically supported claims without calling verify", async () => {
    const verify = neverCalled();
    const markdown = `## Protein synthesis\n\n${SUPPORTED}\n`;
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify });
    expect(result.markdown).toBe(markdown);
    expect(verify).not.toHaveBeenCalled();
    expect(result.report).toMatchObject({ total: 1, cited: 1, lexicalSupported: 1, verifiedSupported: 0, unsourced: 0 });
  });

  it("keeps a lexical miss that the verifier supports", async () => {
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: true })));
    const markdown = INVENTED;
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify });
    expect(result.markdown).toBe(markdown);
    expect(verify).toHaveBeenCalledTimes(1);
    const [items] = verify.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].sentence).toBe("Gentamicin is dosed at 250 mg every hour for twelve consecutive weeks.");
    expect(items[0].evidence).toContain("30S ribosomal subunit");
    expect(result.report).toMatchObject({ lexicalSupported: 0, verifiedSupported: 1, unsourced: 0 });
  });

  it("marks a rejected sentence before its trailing citation", async () => {
    const markdown = `${SUPPORTED} ${INVENTED}`;
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify: rejectAll() });
    expect(result.markdown).toBe(
      `${SUPPORTED} Gentamicin is dosed at 250 mg every hour for twelve consecutive weeks. [[unsourced]] [S1 p.14]`,
    );
    expect(result.report).toMatchObject({ total: 2, lexicalSupported: 1, unsourced: 1 });
  });

  it("marks an uncited sentence at its end", async () => {
    const markdown = "Clinicians prescribe unicorn extract for chronic kidney failure.\n";
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify: rejectAll() });
    expect(result.markdown).toBe("Clinicians prescribe unicorn extract for chronic kidney failure. [[unsourced]]\n");
  });

  it("marks list items and table rows in place", async () => {
    const markdown = [
      "- Gentamicin is dosed at 250 mg every hour for twelve weeks [S1 p.14]",
      "1. Vancomycin cures every viral infection within three hours.",
      "",
      "| Drug | Mechanism |",
      "| --- | --- |",
      "| Gentamicin | Dissolves the nuclear membrane of human neurons [S1 p.14] |",
      "| Macrolides | Bind the 50S ribosomal subunit and block translocation [S1 p.15] |",
    ].join("\n");
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify: rejectAll() });
    expect(result.markdown).toBe(
      [
        "- Gentamicin is dosed at 250 mg every hour for twelve weeks [[unsourced]] [S1 p.14]",
        "1. Vancomycin cures every viral infection within three hours. [[unsourced]]",
        "",
        "| Drug | Mechanism |",
        "| --- | --- |",
        "| Gentamicin | Dissolves the nuclear membrane of human neurons [[unsourced]] [S1 p.14] |",
        "| Macrolides | Bind the 50S ribosomal subunit and block translocation [S1 p.15] |",
      ].join("\n"),
    );
    expect(result.report).toMatchObject({ total: 4, cited: 3, lexicalSupported: 1, unsourced: 3 });
  });

  it("searches every page of every source for uncited claims", async () => {
    const verify = neverCalled();
    const markdown = "The treaty of Westphalia ended the Thirty Years War in 1648.";
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE, HISTORY_SOURCE], verify });
    expect(result.markdown).toBe(markdown);
    expect(result.report).toMatchObject({ total: 1, cited: 0, lexicalSupported: 1 });
  });

  it("falls back to all pages when the cited page does not exist", async () => {
    const markdown = "Macrolides bind the 50S ribosomal subunit and block translocation. [S1 p.99]";
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify: neverCalled() });
    expect(result.report.lexicalSupported).toBe(1);
  });

  it("caps verification and marks the overflow as truncated", async () => {
    const claims = [
      "Vancomycin cures every viral infection within three hours.",
      "Penicillin turns bacterial colonies bright purple after sunset.",
      "Macrolides permanently erase long term memories in adults.",
    ];
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: true })));
    const result = await groundDocument({ markdown: claims.join("\n"), sources: [PHARM_SOURCE], verify, maxVerifyItems: 2 });
    expect(verify.mock.calls[0][0]).toHaveLength(2);
    expect(result.markdown.split("\n")).toEqual([claims[0], claims[1], `${claims[2]} [[unsourced]]`]);
    expect(result.report).toMatchObject({ verifiedSupported: 2, unsourced: 1, truncated: true, verifierFailed: false });
  });

  it("truncates evidence to maxEvidenceChars", async () => {
    const verify = vi.fn<VerifyFn>(async () => []);
    await groundDocument({ markdown: INVENTED, sources: [PHARM_SOURCE], verify, maxEvidenceChars: 20 });
    expect(verify.mock.calls[0][0][0].evidence.length).toBeLessThanOrEqual(20);
  });

  it("treats ids missing from the verifier response as unsupported", async () => {
    const verify = vi.fn<VerifyFn>(async () => []);
    const result = await groundDocument({ markdown: INVENTED, sources: [PHARM_SOURCE], verify });
    expect(result.markdown).toContain("[[unsourced]]");
    expect(result.report.verifierFailed).toBe(false);
  });

  it("marks every lexical miss when verify throws", async () => {
    const verify = vi.fn<VerifyFn>(async () => {
      throw new Error("provider down");
    });
    const markdown = `${SUPPORTED}\n${INVENTED}\nVancomycin cures every viral infection within three hours.`;
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify });
    expect(result.markdown.split("\n")).toEqual([
      SUPPORTED,
      "Gentamicin is dosed at 250 mg every hour for twelve consecutive weeks. [[unsourced]] [S1 p.14]",
      "Vancomycin cures every viral infection within three hours. [[unsourced]]",
    ]);
    expect(result.report).toMatchObject({ verifierFailed: true, lexicalSupported: 1, unsourced: 2 });
  });

  it("treats malformed verifier output as a failure", async () => {
    const verify = vi.fn(async () => ({ nope: true })) as unknown as VerifyFn;
    const result = await groundDocument({ markdown: INVENTED, sources: [PHARM_SOURCE], verify });
    expect(result.report.verifierFailed).toBe(true);
    expect(result.markdown).toContain("[[unsourced]]");
  });

  it("is idempotent", async () => {
    const markdown = [
      INVENTED,
      "- Vancomycin cures every viral infection within three hours.",
      "",
      "| Drug | Mechanism |",
      "| --- | --- |",
      "| Gentamicin | Dissolves the nuclear membrane of human neurons [S1 p.14] |",
    ].join("\n");
    const first = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify: rejectAll() });
    const verify = neverCalled();
    const second = await groundDocument({ markdown: first.markdown, sources: [PHARM_SOURCE], verify });
    expect(second.markdown).toBe(first.markdown);
    expect(verify).not.toHaveBeenCalled();
    expect(second.report).toMatchObject({ total: 3, unsourced: 3 });
  });

  it("leaves headings, code, math, and citation-only lines untouched", async () => {
    const markdown = [
      "# Vancomycin cures every viral infection within three hours",
      "",
      "```ts",
      "const claim = 'Vancomycin cures every viral infection within three hours.';",
      "```",
      "",
      "$$",
      "C = D \\times F / V where every dose follows the invented rule",
      "$$",
      "",
      "$$ E = mc^2 is a claim with several words inside $$",
      "",
      "[S1 p.14] [S1 p.15]",
      "",
      "Short line here.",
      "",
      "The dose is `twelve grams every hour for weeks` $x + y$ ok.",
    ].join("\n");
    const verify = neverCalled();
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify });
    expect(result.markdown).toBe(markdown);
    expect(result.report.total).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it("never marks footnote definitions or their continuation lines", async () => {
    const markdown = [
      "Vancomycin cures every viral infection within three hours.[^1]",
      "",
      "[^1]: Penicillin turns bacterial colonies bright purple after sunset.",
      "    Macrolides permanently erase long term memories in adults.",
      "Lazy continuation says gentamicin grows new teeth overnight.",
      "",
      "    Indented paragraph claims aspirin reverses aging in every patient.",
      "",
      "Clinicians prescribe unicorn extract for chronic kidney failure.",
    ].join("\n");
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify: rejectAll() });
    expect(result.markdown.split("\n")).toEqual([
      "Vancomycin cures every viral infection within three hours.[^1] [[unsourced]]",
      "",
      "[^1]: Penicillin turns bacterial colonies bright purple after sunset.",
      "    Macrolides permanently erase long term memories in adults.",
      "Lazy continuation says gentamicin grows new teeth overnight.",
      "",
      "    Indented paragraph claims aspirin reverses aging in every patient.",
      "",
      "Clinicians prescribe unicorn extract for chronic kidney failure. [[unsourced]]",
    ]);
    expect(result.report).toMatchObject({ total: 2, unsourced: 2 });
  });

  it("does not split on abbreviations, decimals, or citation page dots", async () => {
    const markdown =
      "Aminoglycosides, e.g. gentamicin, bind the 30S ribosomal subunit and cause 2.5 fold mRNA misreading. [S1 p.14] Macrolides bind the 50S ribosomal subunit and block translocation. [S1 p.15]";
    const verify = neverCalled();
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify });
    expect(result.report).toMatchObject({ total: 2, cited: 2, lexicalSupported: 2 });
  });
});
