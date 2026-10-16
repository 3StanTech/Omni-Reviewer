import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { boundTermFlagTerms, readStudyDocumentMeta } from "@/lib/citations";
import { claimKey, type GroundingReport, type GroundingSource } from "@/lib/grounding";
import { recheckDocument } from "@/lib/recheck-tags";
import {
  citedReasonText,
  UNSOURCED_VERIFIER_REASON,
  unsourcedReasonText,
  unsourcedTagPage,
  unsourcedTagTerms,
} from "@/components/unsourced-tag";

const SUN_TZU = "The battle against infectious diseases is a timeless conflict, famously likened to Sun Tzu's Art of War. [S1 p.1]";
const TIGECYCLINE = "Tigecycline covers resistant gram-negative organisms in severe hospital infections. [S1 p.2]";
const SOURCES: GroundingSource[] = [{
  index: 1,
  text: [
    "<<<page 1>>>",
    "The battle against infectious diseases is a timeless conflict, likened to The Art of War by Sun Tzu.",
    "<<<page 2>>>",
    "Doxycycline covers resistant gram-negative organisms in severe hospital infections.",
  ].join("\n"),
}];
const tag = (claim: string) => claim.replace(/ \[S1 p\.\d+\]$/, (cite) => ` [[unsourced]]${cite}`);

const PREVIOUS: GroundingReport = {
  total: 2, cited: 2, lexicalSupported: 0, verifiedSupported: 0, unsourced: 2, truncated: false, verifierFailed: false,
  termFlagged: 2,
};

describe("recheckDocument", () => {
  it("clears a false flag, keeps a real one and records its reason", async () => {
    const markdown = [tag(SUN_TZU), "", tag(TIGECYCLINE)].join("\n");
    const result = await recheckDocument({ markdown, sources: SOURCES, previous: PREVIOUS });

    expect(result.markdown).toBe([SUN_TZU, "", tag(TIGECYCLINE)].join("\n"));
    expect(result.tagsBefore).toBe(2);
    expect(result.tagsAfter).toBe(1);
    expect(result.cleared).toEqual([SUN_TZU.replace(" [S1 p.1]", "").slice(0, 100)]);
    expect(result.stillFlagged).toEqual({ Tigecycline: 1 });
    expect(result.changed).toBe(true);
    expect(result.report).toMatchObject({ unsourced: 1, termFlagged: 1, verifierFailed: false, truncated: false });
    expect(result.report.termFlags).toEqual({ [claimKey(TIGECYCLINE)]: ["Tigecycline"] });
  });

  it("reports no change when the tags and reasons are already current", async () => {
    const markdown = tag(TIGECYCLINE);
    const previous = { ...PREVIOUS, termFlags: { [claimKey(TIGECYCLINE)]: ["Tigecycline"] } };
    const result = await recheckDocument({ markdown, sources: SOURCES, previous });
    expect(result.markdown).toBe(markdown);
    expect(result.cleared).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("keeps a tagged lexical miss tagged, with its earlier verifier flags", async () => {
    const miss = "Linezolid is dosed every twelve hours for complicated skin infections in adults. [S1 p.2]";
    const previous = { ...PREVIOUS, verifierFailed: true };
    const result = await recheckDocument({ markdown: tag(miss), sources: SOURCES, previous });
    expect(result.markdown).toBe(tag(miss));
    expect(result.tagsAfter).toBe(1);
    expect(result.report.verifierFailed).toBe(true);
  });

  it("clears a tagged near-miss by the second look and lists it", async () => {
    // Synthetic: rewords page 3 below the lexical threshold, cited on the adjacent page.
    const nearMiss = "Vancomycin attaches to peptidoglycan precursors, halting construction of the wall in staphylococcal bacteria gradually. [S1 p.2]";
    const sources: GroundingSource[] = [{
      index: 1,
      text: [
        SOURCES[0].text,
        "<<<page 3>>>",
        "Vancomycin binds the terminal alanine residues of peptidoglycan precursors, which blocks cell wall growth in staphylococcal organisms and explains its slow bactericidal effect.",
      ].join("\n"),
    }];
    const markdown = [tag(nearMiss), "", tag(TIGECYCLINE)].join("\n");
    const preview = nearMiss.replace(" [S1 p.2]", "").slice(0, 100);

    const result = await recheckDocument({ markdown, sources, previous: PREVIOUS });
    expect(result.markdown).toBe([nearMiss, "", tag(TIGECYCLINE)].join("\n"));
    expect(result.cleared).toEqual([preview]);
    expect(result.secondLookCleared).toEqual([preview]);
    expect(result.termFlagTagsKept).toBe(1);
    expect(result.report).toMatchObject({ secondLookSupported: 1, secondLookKeys: [claimKey(nearMiss)] });

    const strict = await recheckDocument({ markdown, sources, previous: PREVIOUS, secondLookThreshold: 0.5 });
    expect(strict.secondLookCleared).toEqual([]);
    expect(strict.tagsAfter).toBe(2);
  });

  it("never reaches a model: no ai import and no verify function", () => {
    const core = readFileSync(join(process.cwd(), "lib/recheck-tags.ts"), "utf8");
    const script = readFileSync(join(process.cwd(), "scripts/recheck-tags.ts"), "utf8");
    for (const source of [core, script]) {
      expect(source).not.toMatch(/@\/lib\/ai"|openrouter|replayVerify/i);
      expect(source).not.toMatch(/\bverify\s*:/);
    }
    expect(core).toContain("skipVerifier: true");
    expect(script).toContain("expectedRevision: view.revision");
  });
});

describe("stored term reasons", () => {
  const meta = (termFlags: unknown) => readStudyDocumentMeta({ citationSources: [], grounding: { ...PREVIOUS, termFlags } });

  it("reads valid reasons", () => {
    expect(meta({ abcd1234: ["Tzu", "AZT"] })?.grounding?.termFlags).toEqual({ abcd1234: ["Tzu", "AZT"] });
  });

  it.each([
    ["an array", ["Tzu"]],
    ["a non-list value", { abcd1234: "Tzu" }],
    ["an empty list", { abcd1234: [] }],
    ["too many terms", { abcd1234: ["a", "b", "c", "d", "e", "f"] }],
    ["a long term", { abcd1234: ["x".repeat(41)] }],
    ["a long key", { ["k".repeat(17)]: ["Tzu"] }],
    ["too many keys", Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, ["T"]]))],
  ])("drops %s and keeps the rest of the report", (_, termFlags) => {
    const grounding = meta(termFlags)?.grounding;
    expect(grounding?.termFlags).toBeUndefined();
    expect(grounding?.unsourced).toBe(2);
  });

  it("keeps valid second-look fields and drops malformed ones", () => {
    const read = (fields: Record<string, unknown>) =>
      readStudyDocumentMeta({ citationSources: [], grounding: { ...PREVIOUS, ...fields } })?.grounding;
    expect(read({ secondLookSupported: 2, secondLookKeys: ["abcd1234", "abcd1235"] })).toMatchObject({
      secondLookSupported: 2,
      secondLookKeys: ["abcd1234", "abcd1235"],
    });
    for (const fields of [
      { secondLookSupported: -1, secondLookKeys: "abcd1234" },
      { secondLookSupported: 1.5, secondLookKeys: [42] },
      { secondLookSupported: "3", secondLookKeys: ["k".repeat(17)] },
      { secondLookSupported: Number.MAX_VALUE, secondLookKeys: Array.from({ length: 201 }, (_, i) => `k${i}`) },
    ]) {
      const grounding = read(fields);
      expect(grounding?.secondLookSupported).toBeUndefined();
      expect(grounding?.secondLookKeys).toBeUndefined();
      expect(grounding?.unsourced).toBe(2);
    }
  });

  it("bounds terms before they are stored", () => {
    expect(boundTermFlagTerms(["a", "b", "c", "d", "e", "f"])).toEqual(["a", "b", "c", "d", "e"]);
    expect(boundTermFlagTerms(["y".repeat(50)])).toEqual(["y".repeat(40)]);
  });
});

describe("tag reason line", () => {
  it("names the missing terms, else the checker's rejection", () => {
    expect(unsourcedReasonText(["Tzu", "AZT"])).toBe("Not found in your sources: Tzu, AZT");
    expect(unsourcedReasonText(null)).toBe("The checker could not match this sentence to its cited page.");
    expect(unsourcedReasonText([])).toBe(UNSOURCED_VERIFIER_REASON);
  });

  it("finds each rendered tag's recorded terms", () => {
    const content = [tag(SUN_TZU), "", "```", "[[unsourced]]", "```", "", tag(TIGECYCLINE)].join("\n");
    const termFlags = { [claimKey(TIGECYCLINE)]: ["Tigecycline"] };
    expect(unsourcedTagTerms(content, 0, termFlags)).toBeNull();
    expect(unsourcedTagTerms(content, 1, termFlags)).toEqual(["Tigecycline"]);
    expect(unsourcedTagTerms(content, 2, termFlags)).toBeNull();
  });

  it("is passed the document's reasons by the study document", () => {
    const document = readFileSync(join(process.cwd(), "components/study-document.tsx"), "utf8");
    expect(document).toContain("termFlags: grounding ? grounding.termFlags ?? {} : undefined");
  });
});

describe("cited tag page and reason", () => {
  it("names the claim's own first page citation", () => {
    const doc = "Intro line.\n\n- Tigecycline covers resistant organisms in severe hospital infections. [[unsourced]] [S1 pp.4-5]";
    expect(unsourcedTagPage(doc, 0)).toEqual({ source: 1, page: 4, pageEnd: 5 });
  });

  it("uses a table row's borrowed caption page", () => {
    const doc = [
      "Table: Prototype antibiotics [S1 p.11]",
      "",
      "| Drug | Action |",
      "| --- | --- |",
      "| Penicillin G | Inhibits cell wall synthesis in growing bacteria [[unsourced]] |",
    ].join("\n");
    expect(unsourcedTagPage(doc, 0)).toEqual({ source: 1, page: 11, pageEnd: 11 });
  });

  it("returns null for whole-source and uncited claims", () => {
    expect(unsourcedTagPage("Tigecycline covers resistant organisms in severe hospital infections. [[unsourced]] [S1]", 0)).toBeNull();
    expect(unsourcedTagPage("Tigecycline covers resistant organisms in severe hospital infections. [[unsourced]]", 0)).toBeNull();
    expect(unsourcedTagPage("No tag here at all.", 0)).toBeNull();
  });

  it("says which terms the page lacks, else that the wording differs", () => {
    expect(citedReasonText(4, ["BCG"])).toBe("p.4 doesn't mention: BCG");
    expect(citedReasonText(4, null)).toBe("The wording is too different from p.4 to match automatically.");
  });
});
