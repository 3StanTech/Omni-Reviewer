import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { normalizeGeneratedIds } from "@/lib/ai";
import { parseCardedItems, parseTestMeItems } from "@/lib/learning";

describe("Test Me learning contract", () => {
  it("normalizes blank and duplicate generated ids deterministically", () => {
    const items = normalizeGeneratedIds([
      { id: " q1 ", value: "first" },
      { id: "q1", value: "second" },
      { id: "", value: "third" },
    ]);

    expect(items.map((item) => item.id)).toEqual(["q1", "q1-2", "item-3"]);
  });

  it("preserves legacy open-ended items for compatibility", () => {
    expect(parseTestMeItems(null, JSON.stringify([
      {
        id: "q1",
        question: "Explain this concept.",
        answer: "A long answer",
        explanation: "Because.",
      },
    ]))).toEqual([{
      id: "q1",
      question: "Explain this concept.",
      answer: "A long answer",
      explanation: "Because.",
    }]);
  });

  it("accepts only items with at least two nonempty choices", () => {
    expect(parseTestMeItems(null, JSON.stringify([
      {
        id: "q1",
        question: "Which one?",
        choices: ["A", ""],
        answer: "A",
        explanation: "Because.",
      },
    ]))).toEqual([]);
  });

  it("requires a multiple-choice answer to match one of its choices", () => {
    expect(parseTestMeItems(null, JSON.stringify([
      {
        id: "q1",
        question: "Which one?",
        choices: ["A", "B"],
        answer: "C",
        explanation: "Because.",
      },
    ]))).toEqual([]);
  });

  it("normalizes duplicate and blank IDs while parsing persisted items", () => {
    expect(parseTestMeItems(null, JSON.stringify([
      { id: "q1", question: "Q1", answer: "A", explanation: "" },
      { id: "q1", question: "Q2", answer: "B", explanation: "" },
      { id: "", question: "Q3", answer: "C", explanation: "" },
    ])).map((item) => item.id)).toEqual(["q1", "q1-2", "item-3"]);
  });

  it("keeps duplicate-id normalization linear and caps persisted item counts", () => {
    const start = performance.now();
    const normalized = normalizeGeneratedIds(
      Array.from({ length: 2_000 }, () => ({ id: "duplicate", value: "x" })),
    );
    const elapsed = performance.now() - start;
    expect(new Set(normalized.map((item) => item.id)).size).toBe(2_000);
    expect(elapsed).toBeLessThan(1_000);

    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      id: `q${index}`,
      question: "Question",
      answer: "Answer",
      explanation: "",
    }));
    expect(parseTestMeItems(null, JSON.stringify(tooMany))).toEqual([]);
  });

  it("fails closed when duplicate normalization would exceed the id cap", () => {
    const longId = "x".repeat(200);
    expect(parseTestMeItems(null, JSON.stringify([
      { id: longId, question: "Q1", answer: "A", explanation: "" },
      { id: longId, question: "Q2", answer: "B", explanation: "" },
    ]))).toEqual([]);
    expect(parseCardedItems(null, JSON.stringify([
      { id: longId, front: "F1", back: "B1" },
      { id: longId, front: "F2", back: "B2" },
    ]))).toEqual([]);
  });

  it("normalizes card IDs at the persisted/client parser boundary", () => {
    expect(parseCardedItems(null, JSON.stringify([
      { id: " c1 ", front: "F1", back: "B1" },
      { id: "c1", front: "F2", back: "B2" },
      { id: "", front: "F3", back: "B3" },
    ])).map((item) => item.id)).toEqual(["c1", "c1-2", "item-3"]);
  });

  it("associates stable IDs and names with every Test Me answer control", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../components/test-me-view.tsx"),
      "utf8",
    );

    expect(source).toContain("function controlId(itemId: string, suffix: string)");
    expect(source).toContain("id={choiceId}");
    expect(source).toContain('name={controlId(item.id, "choices")}' );
    expect(source).toContain('htmlFor={controlId(item.id, "answer")}' );
    expect(source).toContain('id={controlId(item.id, "answer")}' );
    expect(source).toContain('name={controlId(item.id, "answer")}' );
    expect(source).toContain("aria-labelledby={questionId}");
    expect(source).toContain("aria-labelledby={`${questionId} ${controlId(item.id, \"answer-label\")}`}");
  });

  it("associates stable IDs, names, and labels with reviewer file/date inputs", () => {
    const workspace = readFileSync(
      path.resolve(__dirname, "../components/reviewer-workspace.tsx"),
      "utf8",
    );
    const sources = readFileSync(
      path.resolve(__dirname, "../components/source-panel.tsx"),
      "utf8",
    );

    expect(workspace).toContain('htmlFor="exam-date"');
    expect(workspace).toContain('id="exam-date"');
    expect(workspace).toContain('name="examDate"');
    expect(sources).toContain('htmlFor="source-file-upload"');
    expect(sources).toContain('id="source-file-upload"');
    expect(sources).toContain('name="sourceFiles"');
  });
});
