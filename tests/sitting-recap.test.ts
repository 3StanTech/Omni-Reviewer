import { describe, expect, it } from "vitest";

import { formatSittingDuration, nextReturnCopy, recapFocusSection } from "@/lib/sitting-recap";

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
