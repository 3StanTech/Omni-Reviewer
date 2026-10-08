import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { boundTermFlagTerms, readStudyDocumentMeta } from "@/lib/citations";
import { claimKey, type GroundingReport, type GroundingSource } from "@/lib/grounding";
import { recheckDocument } from "@/lib/recheck-tags";
import {
  UNSOURCED_VERIFIER_REASON,
  unsourcedReasonText,
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
    const tagSource = readFileSync(join(process.cwd(), "components/unsourced-tag.tsx"), "utf8");
    expect(tagSource).toMatch(/text-muted-foreground">\{reason\}/);
  });
});
