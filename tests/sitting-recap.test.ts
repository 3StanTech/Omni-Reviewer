import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SittingRecap } from "@/components/sitting-recap";
import { formatSittingDuration, nextReturnCopy, recapFocusSection, sectionBreakdown } from "@/lib/sitting-recap";

const LOCKED_IN = [
  "# Pack",
  "",
  "## Cells",
  "Cells are the unit of life. [S1 p.1]",
  "Membranes matter. [S1 pp.2-3]",
  "",
  "## Genetics",
  "Genes encode proteins. [S2]",
  "",
  "## Energy",
  "Mitochondria make energy. [S1 p.9]",
].join("\n");

describe("recapFocusSection", () => {
  it("picks the section with the most misses", () => {
    const focus = recapFocusSection({
      lockedIn: LOCKED_IN,
      missedTexts: ["A [S1 p.1]", "B [S1 p.9]", "C [S1 p.9]"],
    });
    expect(focus).toMatchObject({ title: "Energy", misses: 2 });
    expect(focus?.id).toBeTruthy();
  });

  it("breaks ties toward the earlier section", () => {
    const focus = recapFocusSection({ lockedIn: LOCKED_IN, missedTexts: ["A [S1 p.9]", "B [S1 p.2]"] });
    expect(focus).toMatchObject({ title: "Cells", misses: 1 });
  });

  it("counts a miss toward every section it overlaps", () => {
    // A whole-source [S1] miss overlaps both S1 sections; the S1 p.9 miss decides it.
    const focus = recapFocusSection({ lockedIn: LOCKED_IN, missedTexts: ["A [S1]", "B [S1 p.9]"] });
    expect(focus).toMatchObject({ title: "Energy", misses: 2 });
  });

  it("matches a page miss to a whole-source section", () => {
    expect(recapFocusSection({ lockedIn: LOCKED_IN, missedTexts: ["A [S2 p.40]"] })).toMatchObject({
      title: "Genetics",
      misses: 1,
    });
  });

  it("is null without citations, matches or a Locked In", () => {
    expect(recapFocusSection({ lockedIn: LOCKED_IN, missedTexts: ["no citation"] })).toBeNull();
    expect(recapFocusSection({ lockedIn: LOCKED_IN, missedTexts: ["A [S3 p.1]"] })).toBeNull();
    expect(recapFocusSection({ lockedIn: LOCKED_IN, missedTexts: [] })).toBeNull();
    expect(recapFocusSection({ lockedIn: null, missedTexts: ["A [S1 p.1]"] })).toBeNull();
    expect(recapFocusSection({ lockedIn: "", missedTexts: ["A [S1 p.1]"] })).toBeNull();
  });
});

describe("sectionBreakdown", () => {
  it("counts each item once, for the first section it overlaps, in document order", () => {
    const rows = sectionBreakdown({
      lockedIn: LOCKED_IN,
      items: [
        { text: "A [S1 p.9]", correct: true },
        { text: "B [S1 p.1]", correct: false },
        { text: "C [S1 p.2]", correct: true },
        // A whole-source citation overlaps Cells and Energy; it counts for Cells only.
        { text: "D [S1]", correct: true },
        { text: "E [S2 p.4]", correct: false },
      ],
    });
    expect(rows.map(({ title, correct, total }) => ({ title, correct, total }))).toEqual([
      { title: "Cells", correct: 2, total: 3 },
      { title: "Genetics", correct: 0, total: 1 },
      { title: "Energy", correct: 1, total: 1 },
    ]);
    expect(rows.every((row) => row.id)).toBe(true);
  });

  it("groups items without a matching section as Other, last", () => {
    expect(sectionBreakdown({
      lockedIn: LOCKED_IN,
      items: [
        { text: "no citation", correct: true },
        { text: "A [S3 p.1]", correct: false },
        { text: "B [S1 p.1]", correct: true },
      ],
    })).toEqual([
      { id: expect.any(String), title: "Cells", correct: 1, total: 1 },
      { id: "other", title: "Other", correct: 1, total: 2 },
    ]);
  });

  it("puts everything under Other without a Locked In and is empty without items", () => {
    expect(sectionBreakdown({ lockedIn: null, items: [{ text: "A [S1 p.1]", correct: true }] })).toEqual([
      { id: "other", title: "Other", correct: 1, total: 1 },
    ]);
    expect(sectionBreakdown({ lockedIn: LOCKED_IN, items: [] })).toEqual([]);
  });
});

describe("SittingRecap score", () => {
  it("renders a large score with its percent above the lines", () => {
    const html = renderToStaticMarkup(
      createElement(SittingRecap, { title: "Sitting complete", lines: ["Studied for about 2 minutes"], score: { correct: 7, total: 15 } }),
    );
    expect(html).toContain("text-3xl font-semibold tabular-nums");
    expect(html).toContain(">7/15</span>");
    expect(html).toContain(">47%</span>");
    expect(html).toContain("7 of 15 correct, 47 percent");
    expect(html.indexOf("7/15")).toBeLessThan(html.indexOf("Studied for"));
    // With a score, the first line is no longer styled as the headline.
    expect(html).not.toContain("text-sm font-medium text-foreground");
  });

  it("keeps the first line as the headline without a score", () => {
    const html = renderToStaticMarkup(createElement(SittingRecap, { title: "Done", lines: ["3 cards rated"] }));
    expect(html).toContain('<p class="text-sm font-medium text-foreground">3 cards rated</p>');
    expect(html).not.toContain("text-3xl");
  });

  it("shows 0% for an empty sitting", () => {
    const html = renderToStaticMarkup(createElement(SittingRecap, { title: "Done", lines: [], score: { correct: 0, total: 0 } }));
    expect(html).toContain(">0/0</span>");
    expect(html).toContain(">0%</span>");
  });
});

describe("formatSittingDuration", () => {
  it("reads at its boundaries", () => {
    expect(formatSittingDuration(0)).toBe("under a minute");
    expect(formatSittingDuration(59_999)).toBe("under a minute");
    expect(formatSittingDuration(60_000)).toBe("about 1 minute");
    expect(formatSittingDuration(89_999)).toBe("about 1 minute");
    expect(formatSittingDuration(90_000)).toBe("about 2 minutes");
    expect(formatSittingDuration(59 * 60_000)).toBe("about 59 minutes");
    expect(formatSittingDuration(59.5 * 60_000)).toBe("over an hour");
    expect(formatSittingDuration(3 * 3_600_000)).toBe("over an hour");
  });
});

describe("nextReturnCopy", () => {
  const now = new Date(2026, 9, 6, 22, 0);
  const local = (day: number, hour = 9) => new Date(2026, 9, day, hour).toISOString();

  it("is null with nothing rated", () => {
    expect(nextReturnCopy([], now)).toBeNull();
  });

  it("names a single day", () => {
    expect(nextReturnCopy([local(6, 23), local(5)], now)).toBe("Rated cards come back today");
    expect(nextReturnCopy([local(7, 1), local(7, 20)], now)).toBe("Rated cards come back tomorrow");
    expect(nextReturnCopy([local(10)], now)).toBe("Rated cards come back in 4 days");
  });

  it("names a range when days differ", () => {
    expect(nextReturnCopy([local(7), local(10)], now)).toBe("Rated cards come back between tomorrow and in 4 days");
    expect(nextReturnCopy([local(6, 23), local(9)], now)).toBe("Rated cards come back between today and in 3 days");
  });

  it("writes no em dashes", () => {
    expect(nextReturnCopy([local(7), local(10)], now)).not.toContain("—");
    expect(formatSittingDuration(120_000)).not.toContain("—");
  });
});
