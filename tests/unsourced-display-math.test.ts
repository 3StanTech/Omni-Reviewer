import { describe, expect, it } from "vitest";

import { claimSentences, resolveUnsourcedClaim, unsourcedTokenOffsets, UNSOURCED_TOKEN } from "@/lib/citations";
import { taggedClaims, unsourcedClaimKey } from "@/lib/grounding";

const FIRST = "Amplitude modulation varies the carrier amplitude with the message signal. [[unsourced]] [S1 p.2]";
const SECOND = "The modulation index compares the message amplitude with the carrier amplitude. [[unsourced]] [S1 p.9]";
const THIRD = "Overmodulation distorts the envelope when the index exceeds one in practice. [[unsourced]] [S1 p.9]";
const DOC = [
  FIRST,
  "",
  "$$v(t) = (E_c + e_m) \\sin(\\omega_c t)$$ [S1 p.6]",
  "",
  SECOND,
  "",
  "$$m = \\frac{E_m}{E_c}$$ [S1 p.9]",
  "",
  THIRD,
].join("\n");

function rawOffsets(markdown: string): number[] {
  const offsets: number[] = [];
  for (let at = markdown.indexOf(UNSOURCED_TOKEN); at >= 0; at = markdown.indexOf(UNSOURCED_TOKEN, at + 1)) offsets.push(at);
  return offsets;
}

describe("display math closed on its line", () => {
  it("finds every tag after a single-line display formula with a citation", () => {
    expect(unsourcedTokenOffsets(DOC)).toEqual(rawOffsets(DOC));
    expect(unsourcedTokenOffsets(DOC)).toHaveLength(3);
  });

  it("keeps and deletes the second and third tags", () => {
    expect(resolveUnsourcedClaim(DOC, 1, "keep")).toBe(DOC.replace(SECOND, SECOND.replace(" [[unsourced]]", "")));
    expect(resolveUnsourcedClaim(DOC, 2, "keep")).toBe(DOC.replace(THIRD, THIRD.replace(" [[unsourced]]", "")));
    const deleted = resolveUnsourcedClaim(DOC, 1, "delete");
    expect(deleted).not.toBeNull();
    expect(deleted).not.toContain("modulation index compares");
    expect(deleted).toContain("$$m = \\frac{E_m}{E_c}$$ [S1 p.9]");
    expect(resolveUnsourcedClaim(DOC, 2, "delete")).not.toContain("Overmodulation");
  });

  it("does not make the formula line a claim", () => {
    expect(claimSentences(DOC).map((claim) => claim.text).some((text) => text.includes("$$"))).toBe(false);
  });

  it("maps each offset to the claim key in taggedClaims order", () => {
    const keys = unsourcedTokenOffsets(DOC).map((offset) => unsourcedClaimKey(DOC, offset));
    expect(keys).toEqual(taggedClaims(DOC).map((entry) => entry.key));
    expect(keys.every(Boolean)).toBe(true);
  });

  it("finds a tag written after the formula on the same line", () => {
    const markdown = "$$x$$ [S1 p.2] [[unsourced]]\n\nA later sentence about the carrier stays tagged here. [[unsourced]]";
    expect(unsourcedTokenOffsets(markdown)).toEqual(rawOffsets(markdown));
  });

  it("still masks a tag inside a multi-line display block", () => {
    const markdown = ["$$", "x = 1 [[unsourced]]", "$$", "", SECOND].join("\n");
    expect(unsourcedTokenOffsets(markdown)).toEqual([rawOffsets(markdown)[1]]);
  });
});
