import { describe, expect, it } from "vitest";

import { stripDocumentFraming, stripSelfReference } from "@/lib/study-framing";

describe("stripDocumentFraming", () => {
  it("removes the live Trans 5 framing sentence and preserves the pharmacology sentence", () => {
    const kept = "The study of anti-infectious disease agents represents one of the most critical intersections of pharmacology.";
    const framing = "This guide systematically defines key terminology, outlines the molecular basis of chemotherapy.";
    expect(stripDocumentFraming(`${kept} ${framing}`)).toBe(kept);
  });

  it.each([
    "This guide", "This study guide", "This document", "This reviewer", "This summary",
    "This Locked In", "In this guide", "In this study guide", "In this document",
  ])("removes a whole sentence starting with %s and keeps the remaining paragraph byte-identical", (prefix) => {
    const kept = "A supported  fact preserves **bold**, *italics* and [S1 p.3].";
    expect(stripDocumentFraming(`${prefix} describes the study material. ${kept}`)).toBe(kept);
    expect(stripDocumentFraming(`${kept} ${prefix} describes the study material.`)).toBe(kept);
  });

  it("removes only the framing sentence in the middle of a paragraph", () => {
    const before = "Drug  mechanisms retain **exact formatting**. [S1 p.2]";
    const after = "An adverse effect remains unchanged. [S1 p.3]";
    expect(stripDocumentFraming(`${before} This guide explains its purpose. ${after}`)).toBe(`${before} ${after}`);
  });

  it.each(["-", "*", "+", "1."])("drops a %s list item consisting only of framing", (marker) => {
    const before = `${marker} A supported fact. [S1 p.1]`;
    const after = `${marker} Another supported fact. [S1 p.2]`;
    expect(stripDocumentFraming(`${before}\n${marker} This document describes the course.\n${after}`)).toBe(`${before}\n${after}`);
  });

  it("keeps a list item when it still contains study content", () => {
    expect(stripDocumentFraming("- This guide reviews the material. The drug inhibits synthesis. [S1 p.2]"))
      .toBe("- The drug inhibits synthesis. [S1 p.2]");
  });

  it("drops an emptied paragraph without losing adjacent paragraphs", () => {
    expect(stripDocumentFraming("First fact.\n\nThis reviewer describes its contents.\n\nLast fact."))
      .toBe("First fact.\n\nLast fact.");
    expect(stripDocumentFraming("This summary describes its contents.")).toBe("");
  });

  it("drops a paragraph consisting of several framing sentences", () => {
    expect(stripDocumentFraming("This guide covers the course. In this document, topics are reviewed."))
      .toBe("");
  });

  it.each(["```", "~~~~"])("preserves %s fenced code and strips framing outside the fence", (fence) => {
    const code = `${fence}text\nThis guide describes a code example.\nIn this document, code stays untouched.\n${fence}`;
    expect(stripDocumentFraming(code)).toBe(code);
    expect(stripDocumentFraming(`${code}\n\nThis guide describes the course.\n\nA study fact.`))
      .toBe(`${code}\n\nA study fact.`);
  });

  it("leaves table headers and cells byte-identical", () => {
    const table = [
      "| This guide describes a column. | Evidence |",
      "| --- | --- |",
      "| This document describes a row. | In this guide, preserve this text. |",
    ].join("\n");
    expect(stripDocumentFraming(table)).toBe(table);
    expect(stripDocumentFraming(`${table}\n\nThis summary describes the table.\n\nA fact.`))
      .toBe(`${table}\n\nA fact.`);
  });

  it("preserves tables without leading pipes byte-identically", () => {
    const table = "Label | Mechanism\n--- | ---\nThis guide | Propranolol blocks beta receptors.";
    expect(stripDocumentFraming(table)).toBe(table);
    expect(stripDocumentFraming(`${table}\n\nThis summary describes the table.\n\nA study fact.`))
      .toBe(`${table}\n\nA study fact.`);
  });

  it("leaves every line containing a pipe unchanged, including ordinary prose", () => {
    const line = "This guide uses Label | Mechanism to describe the course.";
    expect(stripDocumentFraming(line)).toBe(line);
  });

  it.each([
    "This guide describes the course. Propranolol blocks beta receptors.  ",
    "Propranolol blocks beta receptors. This guide describes the course.  ",
  ])("preserves a trailing Markdown hard break when removing a framing sentence (%#)", (line) => {
    expect(stripDocumentFraming(line)).toBe("Propranolol blocks beta receptors.  ");
    expect(stripDocumentFraming(`${line}\nThe next line stays unchanged.`))
      .toBe("Propranolol blocks beta receptors.  \nThe next line stays unchanged.");
  });

  it("leaves all heading levels byte-identical", () => {
    const headings = Array.from({ length: 6 }, (_, i) => `${"#".repeat(i + 1)} This guide describes a heading. [S1 p.2]`).join("\n\n");
    expect(stripDocumentFraming(headings)).toBe(headings);
  });

  it("leaves study prose and its whitespace byte-identical when no sentence matches", () => {
    const markdown = "## Pharmacology\n\nA  drug inhibits synthesis. [S1 p.2]\nA second line keeps *italics*.\n\n- A supported  fact.\n";
    expect(stripDocumentFraming(markdown)).toBe(markdown);
    expect(stripDocumentFraming("")).toBe("");
  });
});

describe("stripSelfReference", () => {
  it.each([
    ["According to the document, which drug treats PJP?", "Which drug treats PJP?"],
    ["As described in this guide, what does TMP-SMX inhibit?", "What does TMP-SMX inhibit?"],
    ["Which enzyme is described in the document as the target?", "Which enzyme is described as the target?"],
    ["What is the first-line drug, as stated in the study guide?", "What is the first-line drug?"],
    ["The drug is first line in the notes [S1 p.2].", "The drug is first line [S1 p.2]."],
    ["**In the document,** what is the dose?", "What is the dose?"],
  ])("rewrites %s", (input, expected) => {
    expect(stripSelfReference(input)).toBe(expected);
  });

  it.each([
    "Which document must the pharmacist sign before dispensing?",
    "What is stated in the text of the prescription label?",
    "Record the dose in the patient's medication document.",
    "{{TMP-SMX}} treats PJP.",
  ])("leaves %s unchanged", (input) => {
    expect(stripSelfReference(input)).toBe(input);
  });

  it("keeps the original when nothing else is left", () => {
    expect(stripSelfReference("In the document")).toBe("In the document");
  });
});
