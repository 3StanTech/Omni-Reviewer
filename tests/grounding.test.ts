import { describe, expect, it, vi } from "vitest";
import {
  claimKey,
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
// A lexical miss whose specific terms are present, isolating the verifier's support decision.
const VERIFIED_PARAPHRASE = "Gentamicin disrupts translation through irreversible attachment, producing lethal miscoding and defective bacterial polypeptides. [S1 p.14]";

function neverCalled(): VerifyFn {
  return vi.fn<VerifyFn>(async () => {
    throw new Error("verify should not be called");
  });
}

function rejectAll(): VerifyFn {
  return vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: false })));
}

describe("lexical helpers", () => {
  it("gives claims stable 8-hex FNV-1a keys without citation or unsourced-token noise", () => {
    expect(claimKey("hello world")).toBe("d58b3fa7");
    const key = claimKey("Café Gentamicin binds the ribosomal subunit.");
    expect(key).toMatch(/^[0-9a-f]{8}$/);
    expect(claimKey("CAFÉ Gentamicin binds the ribosomal subunit. [[unsourced]] [S1 p.14]")).toBe(key);
    expect(claimKey("Café Gentamicin binds the ribosomal subunit. [S2 p.3, p.4]")).toBe(key);
    expect(claimKey("Café Gentamicin dissolves the nuclear membrane.")).not.toBe(key);
  });

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

describe("groundDocument term guard", () => {
  const vectorClaim = "Malaria is transmitted by *Anopheles* mosquitoes to susceptible human hosts. [S1 p.6]";
  const calciumClaim = "Daptomycin depolarizes the Gram-positive cytoplasmic membrane in a calcium-dependent manner. [S1 p.10]";
  const sources: GroundingSource[] = [{
    index: 1,
    text: `${PHARM_SOURCE.text}\n<<<page 6>>>\nMosquitoes carry infections.\n<<<page 10>>>\nDaptomycin depolarizes the Gram-positive cytoplasmic membrane.`,
  }];

  function approveAll() {
    return vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: true })));
  }

  function expectPartition(result: Awaited<ReturnType<typeof groundDocument>>) {
    const { report } = result;
    expect(report.total).toBe(
      report.lexicalSupported + report.verifiedSupported + report.unsourced + (report.unchecked ?? 0),
    );
    expect(report.unsourced).toBe((result.markdown.match(/\[\[unsourced\]\]/g) ?? []).length);
  }

  it("overrides an approving verifier when the claim has a term absent from all sources", async () => {
    expect(lexicalSupport(vectorClaim, sources[0].text)).toBeLessThan(LEXICAL_SUPPORT_THRESHOLD);
    const verify = approveAll();
    const result = await groundDocument({ markdown: vectorClaim, sources, verify });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0][0].sentence).toContain("Anopheles");
    expect(result.markdown).toBe(vectorClaim.replace(" [S1 p.6]", " [[unsourced]] [S1 p.6]"));
    expect(result.report).toMatchObject({
      total: 1, cited: 1, termFlagged: 1, lexicalSupported: 0, verifiedSupported: 0, unsourced: 1,
    });
    expectPartition(result);
  });

  it("overrides lexical support without sending the claim to the verifier", async () => {
    const page = "Daptomycin depolarizes the Gram-positive cytoplasmic membrane.";
    expect(lexicalSupport(calciumClaim, page)).toBeGreaterThanOrEqual(LEXICAL_SUPPORT_THRESHOLD);
    const verify = neverCalled();
    const result = await groundDocument({ markdown: calciumClaim, sources, verify });

    expect(verify).not.toHaveBeenCalled();
    expect(result.markdown).toBe(calciumClaim.replace(" [S1 p.10]", " [[unsourced]] [S1 p.10]"));
    expect(result.report).toMatchObject({
      total: 1, cited: 1, termFlagged: 1, lexicalSupported: 0, verifiedSupported: 0, unsourced: 1,
    });
    expectPartition(result);
  });

  it("checks vocabulary from all sources rather than only the cited evidence page", async () => {
    const verify = approveAll();
    const result = await groundDocument({
      markdown: vectorClaim,
      sources: [...sources, { index: 2, text: "Anopheles mosquitoes transmit malaria." }],
      verify,
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe(vectorClaim);
    expect(result.report).toMatchObject({ total: 1, lexicalSupported: 0, verifiedSupported: 1, unsourced: 0 });
    expect(result.report.termFlagged ?? 0).toBe(0);
    expectPartition(result);
  });

  it("never tags an untagged kept claim while rechecking another claim", async () => {
    const tagged = SUPPORTED.replace(" [S1 p.14]", " [[unsourced]] [S1 p.14]");
    const verify = neverCalled();
    const result = await groundDocument({
      markdown: `${vectorClaim}\n${tagged}`, sources, verify, recheck: { uncheckedKeys: [] },
    });

    expect(verify).not.toHaveBeenCalled();
    expect(result.markdown).toBe(`${vectorClaim}\n${SUPPORTED}`);
    expect(result.report).toMatchObject({ total: 2, cited: 2, lexicalSupported: 1, verifiedSupported: 0, unsourced: 0 });
    expect(result.report.termFlagged ?? 0).toBe(0);
    // Recheck totals include the kept claim even though this pass does not evaluate it.
    expect(result.report.total).toBe(2);
  });

  it("retains an evaluated tag when the verifier approves a claim with an absent term", async () => {
    const tagged = vectorClaim.replace(" [S1 p.6]", " [[unsourced]] [S1 p.6]");
    const verify = approveAll();
    const result = await groundDocument({ markdown: tagged, sources, verify, recheck: {} });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.markdown).toBe(tagged);
    expect(result.report).toMatchObject({ total: 1, termFlagged: 1, verifiedSupported: 0, unsourced: 1 });
    expectPartition(result);
  });

  it("guards an explicitly recorded unchecked claim when recheck evaluates it", async () => {
    const verify = approveAll();
    const result = await groundDocument({
      markdown: vectorClaim, sources, verify,
      recheck: { uncheckedKeys: [claimKey(vectorClaim)] },
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.markdown).toContain("[[unsourced]]");
    expect(result.report).toMatchObject({ total: 1, termFlagged: 1, verifiedSupported: 0, unsourced: 1 });
    expect(result.report.unchecked ?? 0).toBe(0);
    expect(result.report.uncheckedKeys).toBeUndefined();
    expectPartition(result);
  });

  it("leaves absent terms unchecked when there is no support decision in this pass", async () => {
    const verify = neverCalled();
    const result = await groundDocument({ markdown: vectorClaim, sources, verify, maxVerifyItems: 0 });

    expect(verify).not.toHaveBeenCalled();
    expect(result.markdown).toBe(vectorClaim);
    expect(result.report).toMatchObject({ total: 1, unsourced: 0, unchecked: 1, uncheckedKeys: [claimKey(vectorClaim)] });
    expect(result.report.termFlagged ?? 0).toBe(0);
    expectPartition(result);
  });

  it("partitions mixed cited claims without counting term flags twice", async () => {
    const verified = "Macrolides prevent bacterial expansion by stalling translation. [S1 p.15]";
    const rejected = "Ordinary treatment reverses every infection within twelve hours. [S1 p.6]";
    const unchecked = "Daily exposure restores full recovery without any further treatment. [S1 p.6]";
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({
      id: item.id, supported: !item.sentence.startsWith("Ordinary treatment"),
    })));
    const result = await groundDocument({
      markdown: [SUPPORTED, calciumClaim, verified, vectorClaim, rejected, unchecked].join("\n"),
      sources, verify, maxVerifyItems: 3,
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0]).toHaveLength(3);
    expect(result.report).toMatchObject({
      total: 6, cited: 6, lexicalSupported: 1, verifiedSupported: 1,
      unsourced: 3, termFlagged: 2, unchecked: 1, truncated: true,
    });
    expect(result.report.uncheckedKeys).toEqual([claimKey(unchecked)]);
    expect(result.markdown.split("\n")[2]).toBe(verified);
    expect(result.markdown.split("\n")[5]).toBe(unchecked);
    expectPartition(result);
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
    const markdown = VERIFIED_PARAPHRASE;
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify });
    expect(result.markdown).toBe(markdown);
    expect(verify).toHaveBeenCalledTimes(1);
    const [items] = verify.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].sentence).toBe(VERIFIED_PARAPHRASE.replace(" [S1 p.14]", ""));
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

  it("caps verification and leaves the overflow untagged as unchecked", async () => {
    const claims = [
      "Gentamicin cures every viral infection within three hours.",
      "Penicillin turns bacterial colonies bright purple after sunset.",
      "Macrolides permanently erase long term memories in adults.",
    ];
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: true })));
    const result = await groundDocument({ markdown: claims.join("\n"), sources: [PHARM_SOURCE], verify, maxVerifyItems: 2 });
    expect(verify.mock.calls[0][0]).toHaveLength(2);
    expect(result.markdown.split("\n")).toEqual(claims);
    expect(result.report).toMatchObject({ verifiedSupported: 2, unsourced: 0, unchecked: 1, truncated: true, verifierFailed: false });
    expect(result.report.uncheckedKeys).toEqual([claimKey(claims[2])]);
  });

  it("sends a relevant passage near character 3,000 instead of the start of a long page", async () => {
    const supporting = "Gentamicin attaches to the 30S ribosomal subunit.";
    const filler = "Weather records describe cloudy skies and quiet coastal harbors. ";
    const before = `${filler.repeat(60).slice(0, 2999)} `;
    const page = `${before}${supporting}${filler.repeat(30).slice(0, 4500 - before.length - supporting.length)}`;
    const markdown = "Gentamicin disrupts translation through irreversible attachment, producing lethal miscoding and defective bacterial polypeptides. [S1 p.3]";
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: true })));
    expect(page).toHaveLength(4500);
    expect(page.indexOf(supporting)).toBe(3000);
    expect(lexicalSupport(markdown, page)).toBeLessThan(LEXICAL_SUPPORT_THRESHOLD);

    await groundDocument({
      markdown,
      sources: [{ index: 1, text: `<<<page 3>>>\n${page}` }],
      verify,
      maxEvidenceChars: 2400,
      passageChars: 600,
    });

    expect(verify).toHaveBeenCalledTimes(1);
    const [items] = verify.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0].evidence).toContain(supporting);
    expect(items[0].evidence.length).toBeLessThanOrEqual(2400);
  });

  it.each([1205, 1805, 2400])("bounds evidence across pages and restores window position order at a %i-character cap", async (maxEvidenceChars) => {
    const filler = "Cloudy skies surround quiet coastal harbors. ";
    let page1 = filler.repeat(40).slice(0, 1500);
    const passages = [
      { at: 50, text: "FIRST_WINDOW Gentamicin " },
      { at: 650, text: "SECOND_WINDOW Gentamicin irreversible " },
      { at: 1250, text: "THIRD_WINDOW Gentamicin irreversible attachment " },
    ];
    for (const passage of passages) {
      page1 = `${page1.slice(0, passage.at)}${passage.text}${page1.slice(passage.at + passage.text.length)}`;
    }
    const page2 = `OTHER_PAGE Gentamicin ${filler}`;
    const page3 = `EXCLUDED_PAGE Gentamicin ${filler}`;
    const markdown = "Gentamicin irreversible attachment causes lethal miscoding defective polypeptides prolonged nephrotoxicity mysterious crystallization.";
    const verify = vi.fn<VerifyFn>(async () => []);
    for (const page of [page1, page2, page3]) {
      expect(lexicalSupport(markdown, page)).toBeLessThan(LEXICAL_SUPPORT_THRESHOLD);
    }

    await groundDocument({
      markdown,
      sources: [{ index: 1, text: `<<<page 1>>>\n${page1}\n<<<page 2>>>\n${page2}\n<<<page 3>>>\n${page3}` }],
      verify,
      maxEvidenceChars,
      passageChars: 600,
    });

    const [items] = verify.mock.calls[0];
    expect(items).toHaveLength(1);
    const evidence = items[0].evidence;
    expect(evidence.length).toBeLessThanOrEqual(maxEvidenceChars);
    expect(evidence).toContain("SECOND_WINDOW");
    expect(evidence).toContain("THIRD_WINDOW");
    expect(evidence.indexOf("SECOND_WINDOW")).toBeLessThan(evidence.indexOf("THIRD_WINDOW"));
    expect(evidence).toContain("\n...\n");
    expect(evidence).not.toContain("EXCLUDED_PAGE");
    if (maxEvidenceChars === 2400) {
      expect(evidence).toContain("FIRST_WINDOW");
      expect(evidence).toContain("OTHER_PAGE");
      expect(evidence.indexOf("FIRST_WINDOW")).toBeLessThan(evidence.indexOf("SECOND_WINDOW"));
      expect(evidence.indexOf("THIRD_WINDOW")).toBeLessThan(evidence.indexOf("OTHER_PAGE"));
    }
  });

  it.each([
    { name: "heading before the table", caption: "## Drug mechanisms [S1 p.3]", header: "| Drug | Mechanism [S1 p.2] |", pages: [3] },
    { name: "caption before the table", caption: "Table: Drug mechanisms [S1 p.3]", header: "| Drug | Mechanism |", pages: [3] },
    { name: "header when the caption has no citation", caption: "## Drug mechanisms", header: "| Drug | Mechanism [S1 p.2] |", pages: [2] },
    { name: "all pages when the table has no citation", caption: "## Drug mechanisms", header: "| Drug | Mechanism |", pages: [2, 3] },
  ])("selects evidence for an uncited table row from the $name", async ({ caption, header, pages }) => {
    const sources = [{ index: 1, text: "<<<page 2>>>\nSECOND_PAGE Gentamicin weather records.\n<<<page 3>>>\nTHIRD_PAGE Gentamicin harbor records." }];
    const row = "| Gentamicin | Dissolves the nuclear membrane of human neurons |";
    const markdown = [caption, "", header, "| --- | --- |", row].join("\n");
    const verify = vi.fn<VerifyFn>(async () => []);
    const result = await groundDocument({ markdown, sources, verify, maxEvidenceChars: 2400, passageChars: 600 });

    expect(verify).toHaveBeenCalledTimes(1);
    const [items] = verify.mock.calls[0];
    expect(items).toHaveLength(1);
    for (const [page, marker] of [[2, "SECOND_PAGE"], [3, "THIRD_PAGE"]] as const) {
      if (pages.includes(page)) expect(items[0].evidence).toContain(marker);
      else expect(items[0].evidence).not.toContain(marker);
    }
    expect(result.markdown).toBe(
      [caption, "", header, "| --- | --- |", "| Gentamicin | Dissolves the nuclear membrane of human neurons [[unsourced]] |"].join("\n"),
    );
    expect(result.markdown.split("\n").at(-1)).not.toMatch(/\[S\d/);
  });

  it("counts two overflow claims as unchecked without tagging them", async () => {
    const markdown = [
      "Gentamicin cures every viral infection within three hours.",
      "Penicillin turns bacterial colonies bright purple after sunset.",
      "Macrolides permanently erase long term memories in adults.",
    ].join("\n");
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: true })));
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify, maxVerifyItems: 1 });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0]).toHaveLength(1);
    expect(result.markdown).toBe(markdown);
    expect(result.markdown).not.toContain("[[unsourced]]");
    expect(result.report).toMatchObject({ total: 3, verifiedSupported: 1, truncated: true, unchecked: 2, unsourced: 0 });
    expect(result.report.uncheckedKeys).toHaveLength(2);
    expect(result.report.uncheckedKeys).toEqual(expect.arrayContaining(markdown.split("\n").slice(1).map(claimKey)));
  });

  it("adds verifier failures to the overflow unchecked count", async () => {
    const markdown = [
      "Vancomycin cures every viral infection within three hours.",
      "Penicillin turns bacterial colonies bright purple after sunset.",
      "Macrolides permanently erase long term memories in adults.",
    ].join("\n");
    const verify = vi.fn<VerifyFn>(async () => { throw new Error("provider down"); });
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify, maxVerifyItems: 1 });

    expect(verify).toHaveBeenCalledTimes(2);
    expect(result.markdown).toBe(markdown);
    expect(result.report).toMatchObject({ truncated: true, verifierFailed: true, unchecked: 3, unsourced: 0 });
    expect(result.report.uncheckedKeys).toHaveLength(3);
    expect(result.report.uncheckedKeys).toEqual(expect.arrayContaining(markdown.split("\n").map(claimKey)));
  });

  it("rechecks tagged claims and reports totals and citations for the whole document", async () => {
    const first = "Gentamicin cures every viral infection within three hours.";
    const second = "Penicillin turns bacterial colonies bright purple after sunset.";
    const kept = "Macrolides permanently erase long term memories in adults.";
    const markdown = `${first} [[unsourced]] [S1 p.14]\n${second} [[unsourced]]\n${kept} [S1 p.15]`;
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item, index) => ({ id: item.id, supported: index === 0 })));
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify, recheck: {} });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0].map((item) => item.sentence)).toEqual([first, second]);
    expect(result.markdown).toBe(`${first} [S1 p.14]\n${second} [[unsourced]]\n${kept} [S1 p.15]`);
    expect(result.report).toMatchObject({ total: 3, cited: 2, lexicalSupported: 0, verifiedSupported: 1, unsourced: 1 });
    expect(result.report.unchecked ?? 0).toBe(0);
    expect(result.report.uncheckedKeys).toBeUndefined();
    expect(result.report.unsourced).toBe((result.markdown.match(/\[\[unsourced\]\]/g) ?? []).length);
  });

  it("keeps failed tagged rechecks as unsourced without counting them as unchecked", async () => {
    const markdown = [
      "Vancomycin cures every viral infection within three hours. [[unsourced]]",
      "Penicillin turns bacterial colonies bright purple after sunset. [[unsourced]]",
      "Macrolides permanently erase long term memories in adults.",
    ].join("\n");
    const verify = vi.fn<VerifyFn>(async () => { throw new Error("provider down"); });
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify, recheck: {} });

    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0][0]).toHaveLength(2);
    expect(result.markdown).toBe(markdown);
    expect(result.report).toMatchObject({ total: 3, cited: 0, verifierFailed: true, unsourced: 2 });
    expect(result.report.unchecked ?? 0).toBe(0);
    expect(result.report.uncheckedKeys).toBeUndefined();
  });

  it("keeps a rechecked overflow tag while clearing the verified tag", async () => {
    const first = "Gentamicin cures every viral infection within three hours.";
    const second = "Penicillin turns bacterial colonies bright purple after sunset.";
    const markdown = `${first} [[unsourced]]\n${second} [[unsourced]]`;
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: true })));
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify, recheck: {}, maxVerifyItems: 1 });

    expect(verify.mock.calls[0][0]).toHaveLength(1);
    expect(result.markdown).toBe(`${first}\n${second} [[unsourced]]`);
    expect(result.report).toMatchObject({ total: 2, verifiedSupported: 1, truncated: true, unsourced: 1 });
    expect(result.report.unchecked ?? 0).toBe(0);
    expect(result.report.uncheckedKeys).toBeUndefined();
  });

  it.each([true, false])("rechecks a recorded untagged claim when the verifier returns supported=%s", async (supported) => {
    const kept = "Macrolides permanently erase long term memories in adults.";
    const markdown = `${VERIFIED_PARAPHRASE}\n${kept}`;
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported })));
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify, recheck: { uncheckedKeys: [claimKey(VERIFIED_PARAPHRASE)] } });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0].map((item) => item.sentence)).toEqual([VERIFIED_PARAPHRASE.replace(" [S1 p.14]", "")]);
    expect(result.markdown).toBe(supported
      ? markdown
      : `${VERIFIED_PARAPHRASE.replace(" [S1 p.14]", " [[unsourced]] [S1 p.14]")}\n${kept}`);
    expect(result.report).toMatchObject({ total: 2, cited: 1, verifiedSupported: supported ? 1 : 0, unsourced: supported ? 0 : 1 });
    expect(result.report.unchecked ?? 0).toBe(0);
    expect(result.report.uncheckedKeys).toBeUndefined();
  });

  it.each(["overflow", "failure"] as const)("preserves an untagged unchecked claim and its key on recheck %s", async (reason) => {
    const kept = "Macrolides permanently erase long term memories in adults.";
    const markdown = `${INVENTED}\n${kept}`;
    const key = claimKey(INVENTED);
    const verify = vi.fn<VerifyFn>(async () => { throw new Error("provider down"); });
    const result = await groundDocument({
      markdown, sources: [PHARM_SOURCE], verify,
      recheck: { uncheckedKeys: [key] },
      maxVerifyItems: reason === "overflow" ? 0 : 1,
    });

    expect(verify).toHaveBeenCalledTimes(reason === "overflow" ? 0 : 2);
    expect(result.markdown).toBe(markdown);
    expect(result.report).toMatchObject({ total: 2, cited: 1, unsourced: 0, unchecked: 1, uncheckedKeys: [key], truncated: reason === "overflow", verifierFailed: reason === "failure" });
  });

  it("never evaluates kept sentences or other unrecorded untagged claims", async () => {
    const markdown = `${INVENTED}\n${SUPPORTED}\nMacrolides permanently erase long term memories in adults.`;
    const verify = rejectAll();
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify, recheck: { uncheckedKeys: [] } });

    expect(verify).not.toHaveBeenCalled();
    expect(result.markdown).toBe(markdown);
    expect(result.report).toMatchObject({ total: 3, cited: 2, lexicalSupported: 0, verifiedSupported: 0, unsourced: 0 });
    expect(result.report.unchecked ?? 0).toBe(0);
    expect(result.report.uncheckedKeys).toBeUndefined();
  });

  it("removes lexically supported tags and unchecked keys without calling the verifier", async () => {
    const unchecked = "Macrolides bind the 50S ribosomal subunit and block translocation. [S1 p.15]";
    const kept = "Vancomycin cures every viral infection within three hours.";
    const tagged = SUPPORTED.replace(" [S1 p.14]", " [[unsourced]] [S1 p.14]");
    const verify = neverCalled();
    const result = await groundDocument({
      markdown: `${tagged}\n${unchecked}\n${kept}`, sources: [PHARM_SOURCE], verify,
      recheck: { uncheckedKeys: [claimKey(unchecked)] },
    });

    expect(verify).not.toHaveBeenCalled();
    expect(result.markdown).toBe(`${SUPPORTED}\n${unchecked}\n${kept}`);
    expect(result.report).toMatchObject({ total: 3, cited: 2, lexicalSupported: 2, verifiedSupported: 0, unsourced: 0 });
    expect(result.report.unchecked ?? 0).toBe(0);
    expect(result.report.uncheckedKeys).toBeUndefined();
  });

  it("separates retained tags from retained unchecked keys on a mixed verifier failure", async () => {
    const tagged = "Vancomycin cures every viral infection within three hours. [[unsourced]]";
    const kept = "Macrolides permanently erase long term memories in adults.";
    const markdown = `${tagged}\n${INVENTED}\n${kept}`;
    const key = claimKey(INVENTED);
    const verify = vi.fn<VerifyFn>(async () => { throw new Error("provider down"); });
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify, recheck: { uncheckedKeys: [key] } });

    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0][0]).toHaveLength(2);
    expect(result.markdown).toBe(markdown);
    expect(result.report).toMatchObject({ total: 3, cited: 1, unsourced: 1, unchecked: 1, uncheckedKeys: [key], verifierFailed: true });
    expect(result.report.unsourced).toBe((result.markdown.match(/\[\[unsourced\]\]/g) ?? []).length);
  });

  it("rechecks every untagged lexical miss for a legacy unchecked document", async () => {
    const kept = "Macrolides permanently erase long term memories in adults.";
    const markdown = `${SUPPORTED}\n${INVENTED}\n${kept}`;
    const verify = rejectAll();
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify, recheck: { legacyUnchecked: true } });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verify).mock.calls[0][0].map((item) => item.sentence)).toEqual([
      "Gentamicin is dosed at 250 mg every hour for twelve consecutive weeks.", kept,
    ]);
    expect(result.markdown).toBe(`${SUPPORTED}\nGentamicin is dosed at 250 mg every hour for twelve consecutive weeks. [[unsourced]] [S1 p.14]\n${kept} [[unsourced]]`);
    expect(result.report).toMatchObject({ total: 3, cited: 2, unsourced: 2, verifiedSupported: 0 });
    expect(result.report.unchecked ?? 0).toBe(0);
    expect(result.report.uncheckedKeys).toBeUndefined();
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

  it("retries a failing verifier once, then leaves its claims untagged as unchecked", async () => {
    const verify = vi.fn<VerifyFn>(async () => {
      throw new Error("provider down");
    });
    const markdown = `${SUPPORTED}\n${INVENTED}\nVancomycin cures every viral infection within three hours.`;
    const result = await groundDocument({ markdown, sources: [PHARM_SOURCE], verify });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(result.markdown).toBe(markdown);
    expect(result.report).toMatchObject({ verifierFailed: true, lexicalSupported: 1, unsourced: 0, unchecked: 2 });
    expect(result.report.uncheckedKeys).toHaveLength(2);
    expect(result.report.uncheckedKeys).toEqual(expect.arrayContaining(markdown.split("\n").slice(1).map(claimKey)));
  });

  it("uses the retry when the first verifier call fails", async () => {
    const verify = vi.fn<VerifyFn>()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce([{ id: 0, supported: false }]);
    const result = await groundDocument({ markdown: INVENTED, sources: [PHARM_SOURCE], verify });
    expect(result.report).toMatchObject({ verifierFailed: false, unsourced: 1 });
    expect(result.markdown).toContain("[[unsourced]]");
  });

  it("treats malformed verifier output as a failure", async () => {
    const verify = vi.fn(async () => ({ nope: true })) as unknown as VerifyFn;
    const result = await groundDocument({ markdown: INVENTED, sources: [PHARM_SOURCE], verify });
    expect(result.report).toMatchObject({ verifierFailed: true, unchecked: 1 });
    expect(result.report.uncheckedKeys).toEqual([claimKey(INVENTED)]);
    expect(result.markdown).not.toContain("[[unsourced]]");
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
    const source = { ...PHARM_SOURCE, text: `${PHARM_SOURCE.text}\nA measured factor is 2.5.` };
    const result = await groundDocument({ markdown, sources: [source], verify });
    expect(result.report).toMatchObject({ total: 2, cited: 2, lexicalSupported: 2 });
  });
});

describe("inline math", () => {
  // Hand-written excerpt in the style of a scanned AM lecture page.
  const AM_SOURCE: GroundingSource = {
    index: 1,
    text: [
      "<<<page 33>>>",
      "",
      "Total power of an AM signal",
      "$$P_t = P_c \\left( 1 + \\frac{m^2}{2} \\right)$$",
      "Example: a carrier power of $P_c = 50\\text{ W}$ modulated at $80\\%$ gives $P_t = 66\\text{ W}$.",
    ].join("\n"),
  };
  const FORMULA_CLAIM = String.raw`Total transmitted power is $P_t = P_c \left(1 + \frac{m^2}{2}\right)$; at $m = 0.8$ with $P_c = 50\text{ W}$, the total power is $66\text{ W}$. [S1 p.33]`;

  it("keeps the claim key of the math-stripped sentence that earlier runs stored", async () => {
    const result = await groundDocument({ markdown: FORMULA_CLAIM, sources: [], verify: neverCalled(), maxVerifyItems: 0 });
    // Pinned from the release that deleted inline math before keying.
    expect(result.report.uncheckedKeys).toEqual(["0ae3c85a"]);
    expect(claimKey("Total transmitted power is; at with, the total power is.")).toBe("0ae3c85a");
  });

  it("re-checks a stored key for a sentence with inline math", async () => {
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: true })));
    const result = await groundDocument({
      markdown: FORMULA_CLAIM,
      sources: [{ index: 1, text: "<<<page 33>>>\nUnrelated page about antenna arrays." }],
      verify,
      recheck: { uncheckedKeys: ["0ae3c85a"] },
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.report.uncheckedKeys).toBeUndefined();
  });

  it("sends the verifier the sentence with its inline math", async () => {
    const verify = rejectAll();
    await groundDocument({
      markdown: FORMULA_CLAIM,
      sources: [{ index: 1, text: "<<<page 33>>>\nUnrelated page about antenna arrays." }],
      verify,
    });
    expect(verify).toHaveBeenCalledWith([
      expect.objectContaining({ sentence: String.raw`Total transmitted power is $P_t = P_c \left(1 + \frac{m^2}{2}\right)$; at $m = 0.8$ with $P_c = 50\text{ W}$, the total power is $66\text{ W}$.` }),
    ]);
  });

  it("supports a formula sentence lexically from the page that states the formula", async () => {
    const result = await groundDocument({ markdown: FORMULA_CLAIM, sources: [AM_SOURCE], verify: neverCalled() });
    expect(result.report).toMatchObject({ total: 1, lexicalSupported: 1, unsourced: 0 });
  });

  it("still sends a formula sentence with numbers the page never states to the verifier", async () => {
    const verify = rejectAll();
    const markdown = String.raw`Total transmitted power is $P_t = P_c \left(1 + \frac{m^2}{2}\right)$; at $m = 0.3$ with $P_c = 20\text{ W}$, the total power is $21\text{ W}$. [S1 p.33]`;
    const result = await groundDocument({ markdown, sources: [AM_SOURCE], verify });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.report).toMatchObject({ lexicalSupported: 0, unsourced: 1 });
  });

  it("reads LaTeX the same way on the claim and the source side", () => {
    expect(normalizeForMatch(String.raw`A load of $P_c = 50\text{ W}$ at $80\%$`)).toBe("load 50 w 80");
    expect(normalizeForMatch(String.raw`$$P_c = 50\text{ W}$$ at 80\%`)).toBe(normalizeForMatch(String.raw`$P_c = 50\text{ W}$ at $80\%$`));
    expect(keyTerms(String.raw`A carrier of $P_c = 50\text{ W}$ is used.`)).toContain("50 w");
    const tokens = normalizeForMatch(String.raw`$$\left( 1 + \frac{m^2}{2} \right) \approx \mathrm{dB} \cdot \mathbf{x}$$`).split(" ");
    for (const command of ["left", "right", "frac", "approx", "mathrm", "cdot", "mathbf", "text"]) expect(tokens).not.toContain(command);
  });

  it("runs the term guard on the sentence without its inline math", async () => {
    const verify = vi.fn<VerifyFn>(async (items) => items.map((item) => ({ id: item.id, supported: true })));
    // 33.3 appears only inside the claim's inline math, never in the source.
    const markdown = String.raw`At full modulation the sidebands carry only $\frac{1}{3}$ ($33.3\%$) of the total transmitted power in every case. [S1 p.33]`;
    const result = await groundDocument({ markdown, sources: [AM_SOURCE], verify });
    expect(result.report.termFlagged).toBeUndefined();
    expect(result.markdown).toBe(markdown);
  });
});
