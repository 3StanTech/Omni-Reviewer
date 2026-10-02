import { describe, expect, it } from "vitest";
import { absentTerms, buildSourceVocabulary, specificTerms } from "@/lib/term-guard";

function normalized(terms: string[]): string[] {
  return terms.map((term) => term.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());
}

describe("specificTerms", () => {
  it.each(["*Anopheles*", "_Candida_"])("extracts an italic term from %s", (term) => {
    expect(normalized(specificTerms(`The organism is ${term}.`))).toContain(term.replace(/[*_]/g, "").toLowerCase());
  });

  it("extracts inner capitals, all-caps abbreviations and digit-bearing tokens", () => {
    const terms = normalized(specificTerms("The drug Gentamicin binds DNA near the 30S subunit at 250 mg."));
    expect(terms).toEqual(expect.arrayContaining(["gentamicin", "dna", "30s", "250"]));
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("drug");
  });

  it("extracts all-caps abbreviations and numeric tokens even at the start", () => {
    expect(normalized(specificTerms("DNA carries inherited information."))).toContain("dna");
    expect(normalized(specificTerms("30S binds the antibiotic."))).toContain("30s");
    expect(normalized(specificTerms("A carries ordinary information."))).not.toContain("a");
  });

  it("extracts each compound part with at least four letters", () => {
    const terms = normalized(specificTerms("A calcium-dependent state-of-the-art pathway is dose-independent."));
    expect(terms).toEqual(expect.arrayContaining(["calcium", "dependent", "state", "dose", "independent"]));
    expect(terms).not.toContain("of");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("art");
  });

  it.each([
    "anemia", "arthritis", "fibrosis", "lactase", "daptomycin", "ampicillin",
    "tetracycline", "fluconazole", "ciprofloxacin", "acyclovir", "bactericide", "meropenem",
  ])("extracts the medical-suffix word %s without requiring capitalization", (term) => {
    expect(normalized(specificTerms(`The effect involves ${term}.`))).toContain(term);
  });

  it.each([
    "Ordinary cells carry inherited information.",
    "Ordinary cells persist. Other cells recover.",
    "- Ordinary cells carry inherited information.",
    "*   **Ordinary:** cells carry inherited information.",
    "1. Ordinary cells carry inherited information.",
    "| Ordinary cells | Another ordinary cell |",
  ])("ignores ordinary capitals at sentence, bullet and cell starts: %s", (sentence) => {
    expect(specificTerms(sentence)).toEqual([]);
  });

  it("ignores citations, the unsourced marker, Roman numerals and allowlisted words", () => {
    const sentence = "The Gram Table Figure Note Example Type Class I IV IX XII details [S1 p.6] [S2 pp.10-11, p.18] [[unsourced]].";
    expect(specificTerms(sentence)).toEqual([]);
  });
});

describe("absentTerms", () => {
  it("requires a whole numeric token instead of matching 5 inside 50 (R4)", () => {
    const vocabulary = buildSourceVocabulary(["The recommended dose is 50 mg once daily."]);
    expect(normalized(absentTerms("The recommended dose is 5 mg once daily.", vocabulary))).toContain("5");
    expect(absentTerms("The recommended dose is 50 mg once daily.", vocabulary)).toEqual([]);
  });

  it("requires a whole abbreviation instead of matching CRP inside CRPase (R4)", () => {
    const sentence = "The CRP level is measured daily.";
    expect(normalized(absentTerms(sentence, buildSourceVocabulary(["Only CRPase is measured here."])))).toContain("crp");
    expect(absentTerms(sentence, buildSourceVocabulary(["The CRP level is measured daily."]))).toEqual([]);
  });

  it("does not assemble IL-6-dependent from IL-8, dependent and a separate page number (R5)", () => {
    const vocabulary = buildSourceVocabulary(["IL-8 dependent signal regulates the pathway. Page 6."]);
    expect(absentTerms("The IL-6-dependent signal regulates the pathway.", vocabulary).length).toBeGreaterThan(0);
  });

  it.each(["IL-6 dependent", "IL-6-dependent", "IL 6 dependent"])(
    "accepts the complete numbered compound with equivalent separators: %s (R5)",
    (source) => {
      expect(absentTerms("The IL-6-dependent signal regulates the pathway.", buildSourceVocabulary([source]))).toEqual([]);
    },
  );

  it("requires the complete all-caps compound instead of scattered matching parts (R5)", () => {
    const vocabulary = buildSourceVocabulary(["CRP is measured daily. A separate dependent signal exists."]);
    expect(absentTerms("The CRP-dependent signal regulates the pathway.", vocabulary).length).toBeGreaterThan(0);
  });

  it.each(["CRP-dependent", "CRP dependent"])(
    "accepts the complete all-caps compound with equivalent separators: %s (R5)",
    (source) => {
      expect(absentTerms("The CRP-dependent signal regulates the pathway.", buildSourceVocabulary([source]))).toEqual([]);
    },
  );

  it.each(["Escherichia coli", "E. coli"])(
    "accepts the abbreviated italic organism against %s (R5)",
    (source) => {
      expect(absentTerms("The organism *E. coli* causes infection.", buildSourceVocabulary([source]))).toEqual([]);
    },
  );

  it("does not assemble an italic organism from unrelated words elsewhere in the source (R5)", () => {
    const sentence = "The organism *E. coli* causes infection.";
    expect(absentTerms(sentence, buildSourceVocabulary(["E. marks a separate heading. The isolated word coli appears later."])).length)
      .toBeGreaterThan(0);
  });

  it.each([
    ["β-lactam", "The beta-lactam drug blocks synthesis."],
    ["beta-lactam", "The $\\beta$-lactam drug blocks synthesis."],
    ["α1 receptors", "The alpha1 receptors regulate signaling."],
  ])("canonicalizes Greek notation from source %s (R6)", (source, sentence) => {
    expect(absentTerms(sentence, buildSourceVocabulary([source]))).toEqual([]);
  });

  it.each([
    {
      sentence: "*   **Vector-borne:** Malaria (transmitted by *Anopheles* mosquitoes) [S1 p.6].",
      source: "Vector-borne: Malaria is transmitted by mosquitoes.",
      absent: "anopheles",
    },
    {
      sentence: "Daptomycin: Depolarizes the Gram-positive cytoplasmic membrane in a calcium-dependent manner [S1 p.10].",
      source: "Daptomycin depolarizes the Gram-positive cytoplasmic membrane.",
      absent: "calcium",
    },
    {
      sentence: "Hematotoxicity: Chloramphenicol (risk of dose-independent aplastic anemia) and Sulfonamides [S1 p.11-12].",
      source: "Hematotoxicity: Chloramphenicol and Sulfonamides can cause dose-independent toxicity.",
      absent: "anemia",
    },
  ])("flags $absent in the live claim", ({ sentence, source, absent }) => {
    expect(normalized(absentTerms(sentence, buildSourceVocabulary([source])))).toContain(absent);
  });

  it("accepts a paraphrase when every specific term appears in the source", () => {
    const sentence = "The drug Gentamicin disrupts translation at the 30S subunit and alters DNA activity. [S1 p.14]";
    const source = "Gentamicin binds the 30S ribosomal subunit. DNA activity is altered.";
    expect(absentTerms(sentence, buildSourceVocabulary([source]))).toEqual([]);
  });

  it.each([
    ["The Macrolides block translation.", "macrolide"],
    ["The *abscesses* resolve.", "abscess"],
  ])("accepts singular source forms for %s", (sentence, source) => {
    expect(absentTerms(sentence, buildSourceVocabulary([source]))).toEqual([]);
  });

  it("normalizes case and diacritics across all supplied source texts", () => {
    const sentence = "The *Café* has DNA with Gentamicin nearby.";
    expect(absentTerms(sentence, buildSourceVocabulary(["CAFE dna", "gentamicin"]))).toEqual([]);
  });

  it("accepts the first six letters of a term longer than eight letters", () => {
    expect(absentTerms("The *bactericidal* effect occurs.", buildSourceVocabulary(["bacteria"]))).toEqual([]);
  });

  it("does not apply the six-letter prefix rule to an eight-letter term", () => {
    const vocab = buildSourceVocabulary(["abcdef"]);
    expect(normalized(absentTerms("The *abcdefgh* effect occurs.", vocab))).toContain("abcdefgh");
    expect(absentTerms("The *abcdefghi* effect occurs.", vocab)).toEqual([]);
  });

  it("does not flag sentence-start capitals, citations or allowlisted words against an empty source", () => {
    const sentence = "Ordinary cells recover. The Gram Table Figure Note Example Type Class details [S1 p.6] [[unsourced]].";
    expect(absentTerms(sentence, buildSourceVocabulary([]))).toEqual([]);
  });
});
