import { describe, expect, it } from "vitest";

import {
  cardExportFilename,
  cardsToBasicCsv,
  cardsToClozeCsv,
  cardsToRemNoteText,
  csvField,
  toAnkiCloze,
  type ExportCard,
} from "@/lib/card-export";
import { UNSOURCED_EXPORT_TEXT } from "@/lib/study-export";

describe("csvField", () => {
  it("always quotes and doubles inner quotes", () => {
    expect(csvField("plain")).toBe('"plain"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a, b")).toBe('"a, b"');
  });

  it("keeps line breaks inside the quotes", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
  });
});

describe("toAnkiCloze", () => {
  it("numbers each blank in order", () => {
    expect(toAnkiCloze("{{ATP}} is made in the {{mitochondria}}.")).toBe(
      "{{c1::ATP}} is made in the {{c2::mitochondria}}.",
    );
  });

  it("leaves text without a valid cloze unchanged", () => {
    expect(toAnkiCloze("No blanks here")).toBe("No blanks here");
  });
});

describe("cardsToBasicCsv", () => {
  it("writes Front, Back rows with CRLF endings and escaping", () => {
    const cards: ExportCard[] = [
      { front: 'What is "ATP"?', back: "Energy, for cells.\nUsed everywhere." },
      { front: "Second", back: "Two" },
    ];
    expect(cardsToBasicCsv(cards)).toBe(
      '"What is ""ATP""?","Energy, for cells.\nUsed everywhere."\r\n"Second","Two"\r\n',
    );
  });

  it("strips citations and page markers and spells out unsourced claims", () => {
    const csv = cardsToBasicCsv([
      { front: "Where is ATP made? [S1 p.14]", back: "<<<page 3>>>\nIn mitochondria [S2 pp.3-4]. Cells dream. [[unsourced]]" },
    ]);
    expect(csv).toBe(`"Where is ATP made?","In mitochondria. Cells dream. ${UNSOURCED_EXPORT_TEXT}"\r\n`);
  });

  it("excludes archived and cloze cards", () => {
    const csv = cardsToBasicCsv([
      { front: "Live", back: "Yes" },
      { front: "Gone", back: "No", archivedAt: "2026-10-01T00:00:00.000Z" },
      { front: "{{ATP}} powers cells.", back: "Energy" },
      { front: "Marked cloze {{x}}", back: "", kind: "cloze" },
    ]);
    expect(csv).toBe('"Live","Yes"\r\n');
  });

  it("is empty when there are no basic cards", () => {
    expect(cardsToBasicCsv([])).toBe("");
    expect(cardsToBasicCsv([{ front: "{{a}}", back: "" }])).toBe("");
  });
});

describe("cloze classification", () => {
  it("exports a kind cloze card whose front does not parse as basic", () => {
    const cards: ExportCard[] = [{ front: "Broken {{blank", back: "Answer", kind: "cloze" }];
    expect(cardsToBasicCsv(cards)).toBe('"Broken {{blank","Answer"\r\n');
    expect(cardsToClozeCsv(cards)).toBe("");
  });
});

describe("cardsToRemNoteText", () => {
  it("writes one Front >> Back line per basic card, collapsing line breaks", () => {
    expect(cardsToRemNoteText([{ front: "What is ATP?", back: "Energy\nfor cells." }])).toBe(
      "What is ATP? >> Energy for cells.\n",
    );
  });

  it("keeps RemNote cloze braces and drops the card back", () => {
    expect(
      cardsToRemNoteText([{ front: "{{ATP}} is made in the {{mitochondria}} [S1 p.2].", back: "Extra", kind: "cloze" }]),
    ).toBe("{{ATP}} is made in the {{mitochondria}}.\n");
  });

  it("splits RemNote delimiters inside card text", () => {
    expect(cardsToRemNoteText([{ front: "a >> b << c :: d", back: "x == y >>> z" }])).toBe(
      "a > > b < < c: : d >> x = = y > > > z\n",
    );
  });

  it("cleans citations, markers and unsourced claims and skips archived cards", () => {
    expect(
      cardsToRemNoteText([
        { front: "<<<page 2>>>\nWhere? [S1 p.4]", back: "Here. [[unsourced]]" },
        { front: "Gone", back: "No", archivedAt: "2026-10-01T00:00:00.000Z" },
      ]),
    ).toBe(`Where? >> Here. ${UNSOURCED_EXPORT_TEXT}\n`);
  });

  it("is empty when there are no live cards", () => {
    expect(cardsToRemNoteText([])).toBe("");
  });
});

describe("cardsToClozeCsv", () => {
  it("writes Text, Extra rows with Anki cloze numbering", () => {
    const csv = cardsToClozeCsv([
      { front: "{{ATP}} is made in the {{mitochondria}} [S1 p.2].", back: "See p.2, \"Cells\"", kind: "cloze" },
      { front: "Basic", back: "Card" },
      { front: "{{Old}} card", back: "", archivedAt: new Date("2026-10-01") },
    ]);
    expect(csv).toBe('"{{c1::ATP}} is made in the {{c2::mitochondria}}.","See p.2, ""Cells"""\r\n');
  });

  it("is empty when there are no cloze cards", () => {
    expect(cardsToClozeCsv([])).toBe("");
    expect(cardsToClozeCsv([{ front: "Basic", back: "Card" }])).toBe("");
  });
});

describe("cardExportFilename", () => {
  it("names basic and cloze files after the pack", () => {
    expect(cardExportFilename("Biology", "basic")).toBe("Biology - Basic cards.csv");
    expect(cardExportFilename("Biology", "cloze")).toBe("Biology - Cloze cards.csv");
    expect(cardExportFilename("Biology", "remnote")).toBe("Biology - RemNote cards.txt");
  });

  it("sanitises unsafe characters and falls back to Reviewer", () => {
    expect(cardExportFilename('Bio/Chem: "Week 1"?', "basic")).toBe("Bio Chem Week 1 - Basic cards.csv");
    expect(cardExportFilename("  ", "cloze")).toBe("Pack - Cloze cards.csv");
  });

  it("keeps long names within 120 characters with the label intact", () => {
    const name = cardExportFilename("A".repeat(300), "cloze");
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(" - Cloze cards.csv")).toBe(true);
  });
});
