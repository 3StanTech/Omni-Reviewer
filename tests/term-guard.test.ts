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

  it("extracts each compound part with at least four letters beside a specific part", () => {
    const terms = normalized(specificTerms("A calcium-dependent state-of-the-art pathway is dose-independent."));
    expect(terms).toEqual(expect.arrayContaining(["calcium", "dependent", "dose", "independent"]));
    expect(terms).not.toContain("state");
    expect(terms).not.toContain("of");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("art");
  });

  it.each([
    "Polypeptides stop the peptide-chain growth.",
    "The peptide-chain grows at the ribosome.",
    "A broad-spectrum agent covers both.",
  ])("ignores a compound of ordinary lowercase words: %s", (sentence) => {
    expect(specificTerms(sentence)).toEqual([]);
  });

  it.each([
    "De-escalation narrows therapy once culture results return.",
    "- De-escalation narrows therapy once culture results return.",
    "a) De-escalation narrows therapy once culture results return.",
    "b. De-escalation narrows therapy once culture results return.",
    "Then: De-escalation narrows therapy once culture results return.",
    "**Step 3:** De-escalation narrows therapy once culture results return.",
  ])("ignores a capitalized hyphenated word at a sentence, list, colon or label start: %s", (sentence) => {
    expect(specificTerms(sentence)).toEqual([]);
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

  // Phase 4 replaced R5's whole-compound rule: an abbreviation compound is also
  // present when each part is ("BCG-vaccinated" as "BCG" and "vaccinated").
  it("accepts an all-caps compound whose parts are each present", () => {
    const vocabulary = buildSourceVocabulary(["CRP is measured daily. A separate dependent signal exists."]);
    expect(absentTerms("The CRP-dependent signal regulates the pathway.", vocabulary)).toEqual([]);
    expect(absentTerms("The CRP-dependent signal regulates the pathway.", buildSourceVocabulary(["A dependent signal exists."]))).toEqual(["CRP-dependent", "CRP"]);
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

  it("accepts ordinary hyphenated words the source never writes", () => {
    const vocabulary = buildSourceVocabulary(["Natural peptides form during sickness. Collect specimens before empiric therapy."]);
    expect(absentTerms("Polypeptides stop the peptide-chain growth [S1 p.2].", vocabulary)).toEqual([]);
    expect(absentTerms("- De-escalation follows once specimens are collected.", vocabulary)).toEqual([]);
  });

  it("judges a capitalized prefix compound mid-sentence the same as at the start", () => {
    const vocabulary = buildSourceVocabulary(["Collect appropriate specimens before therapy; narrow coverage once culture results return."]);
    expect(absentTerms("Collect specimens before therapy, then De-escalation narrows coverage.", vocabulary)).toEqual([]);
    expect(absentTerms("Patients on Non-invasive ventilation need specimens.", vocabulary)).toEqual([]);
    expect(absentTerms("Collect specimens, then give TMP-SMX.", vocabulary)).toEqual(["TMP-SMX", "TMP", "SMX"]);
  });

  describe("acronyms", () => {
    const vocabulary = buildSourceVocabulary(["TMP-SMX treats Pneumocystis jiroveci pneumonia."]);

    it("accepts an acronym the sentence spells out with a phrase the source has", () => {
      expect(absentTerms("Pneumocystis jiroveci pneumonia (PJP) responds to TMP-SMX.", vocabulary)).toEqual([]);
    });

    it("flags an acronym the sentence does not spell out", () => {
      expect(absentTerms("TMP-SMX is used for VAP.", vocabulary)).toEqual(["VAP"]);
    });

    it("flags an acronym whose spelled-out phrase the source lacks", () => {
      expect(absentTerms("Ventilator associated pneumonia (VAP) responds to TMP-SMX.", vocabulary)).toEqual(["VAP"]);
    });

    it("accepts a listed synonym acronym when the source has its alias", () => {
      expect(absentTerms("TMP-SMX is used for PCP.", vocabulary)).toEqual([]);
      expect(absentTerms("TMP-SMX is used for PCP.", buildSourceVocabulary(["PJP prophylaxis uses TMP-SMX."]))).toEqual([]);
    });

    it("still flags a listed synonym acronym when the source has no alias", () => {
      expect(absentTerms("TMP-SMX is used for PCP.", buildSourceVocabulary(["TMP-SMX treats urinary infections."]))).toEqual(["PCP"]);
    });
  });

  it.each(["gyrase", "Doxycycline", "Tobramycin", "Levofloxacin", "Colistin"])(
    "still flags the verified true positive %s against a source lacking it",
    (term) => {
      const vocabulary = buildSourceVocabulary([
        "Fluoroquinolones inhibit DNA topoisomerase. Aminoglycosides and polymyxins are nephrotoxic. Tetracyclines bind the 30S subunit.",
      ]);
      expect(absentTerms(`The class also includes ${term} in practice.`, vocabulary)).toEqual([term]);
    },
  );

  it("does not flag sentence-start capitals, citations or allowlisted words against an empty source", () => {
    const sentence = "Ordinary cells recover. The Gram Table Figure Note Example Type Class details [S1 p.6] [[unsourced]].";
    expect(absentTerms(sentence, buildSourceVocabulary([]))).toEqual([]);
  });
});

describe("hyphen and space variants", () => {
  // Hand-written excerpt in the style of an AM lecture page.
  const AM_PAGE = "Standard AM and double-sideband suppressed-carrier (DSBSC) systems. The envelope detector uses a capacitor and resistor as a low pass filter.";

  it("finds a hyphenated abbreviation the source writes as one word, and does not flag its parts", () => {
    expect(absentTerms("**DSBSC (DSB-SC)** keeps both sidebands but drops the carrier.", buildSourceVocabulary([AM_PAGE]))).toEqual([]);
  });

  it("finds a one-word abbreviation the source writes with a hyphen or space", () => {
    expect(absentTerms("A DSBSC transmitter drops the carrier.", buildSourceVocabulary(["The DSB-SC transmitter drops it."]))).toEqual([]);
    expect(absentTerms("A DSBSC transmitter drops the carrier.", buildSourceVocabulary(["The DSB SC transmitter drops it."]))).toEqual([]);
  });

  it("still flags a hyphenated abbreviation and its part when the source never writes it", () => {
    expect(absentTerms("**Standard AM (DSB-LC)** wastes carrier power.", buildSourceVocabulary([AM_PAGE]))).toEqual(["DSB-LC", "DSB", "LC"]);
  });

  it("still flags a short abbreviation the source only spells out", () => {
    expect(absentTerms("The detector uses a low-pass RC filter.", buildSourceVocabulary([AM_PAGE]))).toEqual(["RC"]);
  });

  it("still flags a part that also appears on its own", () => {
    expect(absentTerms("SC differs from DSB-SC in practice.", buildSourceVocabulary([AM_PAGE]))).toEqual(["SC"]);
  });

  it("does not join one-letter words or bare numbers", () => {
    expect(absentTerms("The RC filter smooths ripple.", buildSourceVocabulary(["The R C pair smooths ripple."]))).toEqual(["RC"]);
    expect(normalized(absentTerms("The 2024 report.", buildSourceVocabulary(["Pages 20 24."])))).toContain("2024");
  });
});

describe("possessives, ordinals and aliases", () => {
  const ART_OF_WAR = "Infectious disease is a conflict, as in The Art of War by Sun Tzu.";

  it.each(["Sun Tzu's", "Sun Tzu’s"])("matches the possessive %s to its plain source form", (name) => {
    expect(absentTerms(`The battle is likened to ${name} "Art of War".`, buildSourceVocabulary([ART_OF_WAR]))).toEqual([]);
  });

  it("matches a possessive claim to a plain source and a plain claim to a possessive source", () => {
    expect(absentTerms("These are *Koch's postulates* for causation.", buildSourceVocabulary(["Koch postulates link a microbe to disease."]))).toEqual([]);
    expect(absentTerms("These are *Koch postulates* for causation.", buildSourceVocabulary(["Koch's postulates link a microbe to disease."]))).toEqual([]);
    expect(absentTerms("The rule follows Koch for causation.", buildSourceVocabulary(["Koch’s postulates link a microbe to disease."]))).toEqual([]);
  });

  it("matches a plural possessive written with a trailing apostrophe", () => {
    expect(absentTerms("The method follows Jones' criteria closely.", buildSourceVocabulary(["The Jones criteria guide diagnosis."]))).toEqual([]);
  });

  it("keeps inner apostrophes in names", () => {
    expect(specificTerms("The sign was described by O'Brien in detail.")).toContain("O'Brien");
    expect(absentTerms("The sign was described by O'Brien in detail.", buildSourceVocabulary(["O'Brien described the sign."]))).toEqual([]);
    expect(absentTerms("The sign was described by O'Brien in detail.", buildSourceVocabulary(["Osler described the sign."]))).toEqual(["O'Brien"]);
  });

  it("matches a numbered ordinal to its spelled source form and back", () => {
    expect(absentTerms("Avoid the drug in the 3rd trimester of pregnancy.", buildSourceVocabulary(["It is contraindicated in the third trimester."]))).toEqual([]);
    expect(absentTerms("Avoid the drug in the *Third Trimester* of pregnancy.", buildSourceVocabulary(["It is contraindicated in the 3rd trimester."]))).toEqual([]);
    expect(absentTerms("Avoid the drug in the 3rd-trimester window.", buildSourceVocabulary(["It is contraindicated in the third trimester window."]))).toEqual([]);
  });

  it("still flags a different ordinal", () => {
    expect(absentTerms("Avoid the drug in the 2nd trimester of pregnancy.", buildSourceVocabulary(["It is contraindicated in the third trimester."]))).toEqual(["2nd"]);
  });

  it("treats AZT as present when the source names zidovudine", () => {
    expect(absentTerms("AZT reduces vertical transmission of HIV.", buildSourceVocabulary(["Zidovudine reduces vertical transmission of HIV."]))).toEqual([]);
  });

  it("still flags a drug the source never mentions", () => {
    expect(absentTerms("Tigecycline covers resistant organisms.", buildSourceVocabulary(["Doxycycline covers many organisms."]))).toEqual(["Tigecycline"]);
  });
});

describe("British and US spellings", () => {
  it.each([
    ["amoebicides", "AMEBICIDES and Amebicid agents"],
    ["oedema", "edema"],
    ["anaemia", "anemia"],
    ["haemoglobin", "hemoglobin"],
    ["amoebic", "amebic"],
    ["oesophagus", "esophagus"],
  ])("matches %s and %s in both directions", (british, us) => {
    const sentence = (word: string) => `Treatment uses *${word.split(" ")[0]}* for this patient group.`;
    expect(absentTerms(sentence(british), buildSourceVocabulary([`The source names ${us} here.`]))).toEqual([]);
    expect(absentTerms(sentence(us), buildSourceVocabulary([`The source names ${british} here.`]))).toEqual([]);
  });

  it("matches a capitalized British spelling to a US source word", () => {
    expect(absentTerms("Severe Anaemia follows haemolysis in these cases.", buildSourceVocabulary(["Severe anemia follows hemolysis."]))).toEqual([]);
  });

  it("still flags a term absent in either spelling", () => {
    expect(absentTerms("Tigecycline treats amoebic colitis.", buildSourceVocabulary(["Metronidazole treats amebic colitis."]))).toEqual(["Tigecycline"]);
  });
});

describe("italic spans", () => {
  it("does not take an italic note as one term", () => {
    const sentence = "The gain is 20 dB. *(Note: The dB value represents the negative of the loss in the channel.)*";
    const terms = specificTerms(sentence);
    expect(terms.some((term) => term.includes(" "))).toBe(false);
    expect(terms).toEqual(["20"]);
  });

  it.each(["*Pneumocystis jirovecii*", "*Mycobacterium avium*", "*E. coli*"])("keeps the italic species %s as one term", (span) => {
    expect(specificTerms(`The organism ${span} causes disease.`)).toContain(span.replace(/\*/g, ""));
  });

  it("checks a long italic sentence word by word", () => {
    const terms = specificTerms("The rule holds. *Most cases respond quickly to Vancomycin therapy in adults*.");
    expect(terms).toContain("Vancomycin");
    expect(terms).not.toContain("Most cases respond quickly to Vancomycin therapy in adults");
  });
});

describe("CXR alias", () => {
  it.each(["chest X-ray", "chest x-ray", "chest xray", "chest x ray", "chest radiograph"])("treats CXR as present when the source says %s", (phrase) => {
    expect(absentTerms("A CXR shows the cavitary lesion.", buildSourceVocabulary([`A ${phrase} shows the lesion.`]))).toEqual([]);
  });

  it("still flags CXR without a chest X-ray in the source", () => {
    expect(absentTerms("A CXR shows the cavitary lesion.", buildSourceVocabulary(["A CT scan shows the lesion."]))).toEqual(["CXR"]);
  });
});

describe("compounds of an abbreviation and ordinary words", () => {
  it("finds a compound whose parts are each present on their own", () => {
    expect(absentTerms("BCG-vaccinated children may test positive.", buildSourceVocabulary(["Children vaccinated with BCG may test positive."]))).toEqual([]);
    expect(absentTerms("The IL-6-dependent pathway drives fever.", buildSourceVocabulary(["IL-6 drives fever; the pathway is dependent on it."]))).toEqual([]);
  });

  it("reports the abbreviation when only the ordinary part is present", () => {
    expect(absentTerms("BCG-vaccinated children may test positive.", buildSourceVocabulary(["Vaccinated children may test positive."]))).toEqual(["BCG-vaccinated", "BCG"]);
  });

  it("still flags a compound with an absent ordinary part", () => {
    const terms = absentTerms("Screening matters in high-TB-burden countries.", buildSourceVocabulary(["TB is common in high prevalence countries."]));
    expect(terms).toContain("high-TB-burden");
    expect(terms).toContain("burden");
    expect(terms).not.toContain("TB");
  });
});
