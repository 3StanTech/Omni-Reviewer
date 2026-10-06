import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { stripPageMarkers } from "@/lib/source-markers";
import { detectOutline } from "@/lib/transcript-outline";

function fixture(name: string): string {
  return readFileSync(`tests/fixtures/outlines/${name}.txt`, "utf8");
}

describe("detectOutline", () => {
  it("parses the PHA LE2 05 outline and drops non-content entries", () => {
    const outline = detectOutline(fixture("pha-le2-05"));
    expect(outline?.sections.map((section) => section.heading)).toEqual([
      "Introduction",
      "Definition of Terms",
      "Factors to Consider in the Rational Choice of Antimicrobials",
      "Weapons and Ammunition Against Infectious Organisms",
      "The Molecular Basis of Chemotherapy",
      "General Classification of Antimicrobials",
      "Reasons for Using Combinations of Antimicrobial Agents",
      "Antimicrobial Prophylaxis",
      "Reasons for Antimicrobial Failure",
      "Rational Therapeutic Strategy for Proven or Unsuspected Infectious Diseases",
    ]);
    expect(outline?.sections[1].subs).toEqual([
      "Antibiotics",
      "Chemotherapy",
      "Antimicrobials",
      "Iatrogenesis",
      "Superinfections",
      "Nosocomial Infections",
      "Selective Toxicity",
      "Post-Antibiotic Effect (PAE)",
      "Mutant-Preventing Concentration (MPC)",
    ]);
    expect(outline?.sections[2].subs).toEqual([
      "Factors Related to the Infecting Etiologic Organisms",
      "Epidemiological Factors",
      "Host Factors",
    ]);
    expect(outline?.sections[0].subs).toEqual([]);
  });

  it("parses the MIC LAB LE2 01 outline", () => {
    const outline = detectOutline(fixture("mic-lab-le2-01"));
    expect(outline?.sections.map((section) => section.heading)).toEqual([
      "Mantoux Tuberculin Skin Test",
      "Rapid Antigen Test for Dengue and COVID",
      "Acid Fast Stain",
      "KOH",
    ]);
    expect(outline?.sections[1].subs).toEqual([
      "General Principles",
      "Dengue Rapid Antigen Test",
      "2019 n-COV Rapid Antigen Test",
    ]);
  });

  it("parses the MIC LAB LE3 01 outline", () => {
    const outline = detectOutline(fixture("mic-lab-le3-01"));
    expect(outline?.sections).toHaveLength(5);
    expect(outline?.sections[0]).toEqual({
      heading: "Mycology Specimen Collection",
      subs: ["Specimen Collection for Dermatophytosis"],
    });
    expect(outline?.sections[4].heading).toBe("Evaluation of Antibiotics");
  });

  it("recovers section order from the body when columns interleave", () => {
    const outline = detectOutline(fixture("interleaved"));
    const headings = outline?.sections.map((section) => section.heading) ?? [];
    const starts = [
      "Introduction",
      "Definition of Terms",
      "Factors to Consider",
      "Weapons and Ammunition",
      "The Molecular Basis",
      "General Classification",
      "Reasons for Using",
      "Antimicrobial Prophylaxis",
      "Reasons for Antimicrobial",
      "Rational Therapeutic",
    ];
    expect(headings).toHaveLength(starts.length);
    starts.forEach((start, index) => expect(headings[index].startsWith(start)).toBe(true));
  });

  it("returns null when too few interleaved entries have a body heading", () => {
    const text = fixture("interleaved");
    expect(detectOutline(text.slice(0, text.indexOf("VI. GENERAL")))).toBeNull();
  });

  it("returns null without an OUTLINE line", () => {
    expect(detectOutline(fixture("no-outline"))).toBeNull();
  });

  it("returns null with fewer than two content sections", () => {
    expect(detectOutline("OUTLINE\nI. Introduction\nII. References\nIII. Appendix")).toBeNull();
  });

  it("reads text without page markers", () => {
    const marked = detectOutline(fixture("pha-le2-05"));
    expect(detectOutline(stripPageMarkers(fixture("pha-le2-05")))).toEqual(marked);
  });

  it("stops at the uppercase body heading of entry I", () => {
    const outline = detectOutline(
      "OUTLINE\nI. Introduction\nII. Methods\nA. Sampling\nI. INTRODUCTION 🔺\nBody text.",
    );
    expect(outline).toEqual({
      sections: [
        { heading: "Introduction", subs: [] },
        { heading: "Methods", subs: ["Sampling"] },
      ],
    });
  });

  it("searches only the first two pages", () => {
    const text = "<<<page 1>>>\nTitle\n\n<<<page 2>>>\nBody\n\n<<<page 3>>>\nOUTLINE\nI. One\nII. Two";
    expect(detectOutline(text)).toBeNull();
  });
});
