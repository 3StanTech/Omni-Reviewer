import { describe, expect, it } from "vitest";

import { withFallbackCitations } from "@/lib/test-me-citations";

const item = (explanation: string) => ({ question: "Q?", answer: "A", explanation });

const LOCKED_IN = [
  "## Cells",
  "",
  "The bacterial cell wall is made of peptidoglycan that protects the cell from osmotic lysis. [S1 p.4]",
  "",
  "Mitochondria produce most of the ATP used by eukaryotic cells through oxidative phosphorylation. [S1 pp.7-8]",
].join("\n");

describe("withFallbackCitations", () => {
  it("appends the matching claim's citation to an uncited explanation", () => {
    const [result] = withFallbackCitations(
      [item("The cell wall is made of peptidoglycan, which protects the cell from osmotic lysis.")],
      LOCKED_IN,
    );
    expect(result.explanation).toBe(
      "The cell wall is made of peptidoglycan, which protects the cell from osmotic lysis. [S1 p.4]",
    );
  });

  it("leaves an already-cited explanation untouched", () => {
    const cited = item("Peptidoglycan protects the cell from osmotic lysis. [S2 p.9]");
    const [result] = withFallbackCitations([cited], LOCKED_IN);
    expect(result).toBe(cited);
  });

  it("leaves an item uncited when no claim matches well enough", () => {
    const unrelated = item("Ribosomes translate messenger RNA into polypeptide chains.");
    const [result] = withFallbackCitations([unrelated], LOCKED_IN);
    expect(result).toBe(unrelated);
  });

  it("never borrows from an unsourced claim", () => {
    const lockedIn = "The cell wall is made of peptidoglycan that protects the cell from osmotic lysis. [S1 p.4] [[unsourced]]";
    const uncited = item("The cell wall is made of peptidoglycan, which protects the cell from osmotic lysis.");
    const [result] = withFallbackCitations([uncited], lockedIn);
    expect(result).toBe(uncited);
  });

  it("never borrows from an uncited claim", () => {
    const uncited = item("The cell wall is made of peptidoglycan, which protects the cell from osmotic lysis.");
    const [result] = withFallbackCitations(
      [uncited],
      "The cell wall is made of peptidoglycan that protects the cell from osmotic lysis.",
    );
    expect(result).toBe(uncited);
  });

  it("gives a tie to the earliest candidate", () => {
    const lockedIn = [
      "The cell wall is made of peptidoglycan that protects the cell from osmotic lysis. [S1 p.4]",
      "",
      "The cell wall is made of peptidoglycan that protects the cell from osmotic lysis. [S2 p.9]",
    ].join("\n");
    const [result] = withFallbackCitations(
      [item("The cell wall is made of peptidoglycan, which protects the cell from osmotic lysis.")],
      lockedIn,
    );
    expect(result.explanation.endsWith(" [S1 p.4]")).toBe(true);
  });

  it("copies a multi-page citation verbatim", () => {
    const [result] = withFallbackCitations(
      [item("Mitochondria produce most of the ATP in eukaryotic cells through oxidative phosphorylation.")],
      LOCKED_IN,
    );
    expect(result.explanation).toBe(
      "Mitochondria produce most of the ATP in eukaryotic cells through oxidative phosphorylation. [S1 pp.7-8]",
    );
  });

  it("does not mutate its inputs", () => {
    const original = item("The cell wall is made of peptidoglycan, which protects the cell from osmotic lysis.");
    const items = [original];
    const [result] = withFallbackCitations(items, LOCKED_IN);
    expect(result).not.toBe(original);
    expect(original.explanation).not.toContain("[S1");
    expect(items[0]).toBe(original);
  });
});
