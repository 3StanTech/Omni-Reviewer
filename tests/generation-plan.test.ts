import { describe, expect, it } from "vitest";

import {
  firstIncompleteGenerationKind,
  generationProgress,
  generationStepKinds,
  generationStepDependencies,
  missingGenerationKinds,
  nextGenerationStep,
  nextPendingGenerationStep,
  planGeneration,
} from "@/lib/generation-plan";

describe("generation planning", () => {
  it("plans every mode for an empty pack and preserves dependency order", () => {
    const plan = planGeneration({
      intent: "generate_missing",
      existing: {},
    });

    expect(plan).toMatchObject({
      mode: "full",
      targetKinds: ["locked_in", "summary", "test_me", "carded"],
      initialStep: "locked_in",
      noOp: false,
    });
    expect(nextGenerationStep(plan.targetKinds, "summary")).toBe("test_me");
    expect(generationStepDependencies(plan.targetKinds, "carded")).toEqual(["summary"]);
  });

  it("targets only missing modes and returns a no-op for a complete pack", () => {
    expect(
      missingGenerationKinds({ locked_in: true, summary: true, test_me: false, carded: true }),
    ).toEqual(["test_me"]);
    expect(
      planGeneration({
        intent: "generate_missing",
        existing: { locked_in: true, summary: true, test_me: true, carded: true },
      }),
    ).toMatchObject({ targetKinds: [], initialStep: null, noOp: true });
  });

  it("makes Locked In redo whole-pack and other redo actions selected by default", () => {
    expect(
      planGeneration({ intent: "redo", kind: "locked_in" }).targetKinds,
    ).toEqual(["locked_in", "summary", "test_me", "carded"]);
    expect(
      planGeneration({ intent: "redo", kind: "summary" }).targetKinds,
    ).toEqual(["summary"]);
    expect(
      planGeneration({ intent: "redo", kind: "summary", scope: "full" }).targetKinds,
    ).toEqual(["locked_in", "summary", "test_me", "carded"]);
  });

  it("derives truthful persisted-step percentages", () => {
    expect(
      generationProgress({
        targetKinds: ["locked_in", "summary", "test_me", "carded"],
        completedKinds: ["locked_in", "summary"],
        status: "running",
      }),
    ).toEqual({ total: 4, completed: 2, percentage: 50, terminal: false });
    expect(
      generationProgress({
        targetKinds: ["summary"],
        completedKinds: [],
        status: "succeeded",
      }),
    ).toEqual({ total: 1, completed: 0, percentage: 0, terminal: true });
  });

  it("combines Summary and Test Me only for multi-target runs with a frozen scope", () => {
    const full = ["locked_in", "summary", "test_me", "carded"] as const;
    expect(generationStepKinds({ mode: "full", targetKinds: full }, "summary")).toEqual([
      "summary",
      "test_me",
    ]);
    expect(
      generationStepKinds({ mode: "full", targetKinds: ["summary", "test_me"] }, "summary"),
    ).toEqual(["summary", "test_me"]);
    expect(generationStepKinds({ mode: "full", targetKinds: full }, "test_me")).toEqual(["test_me"]);
    expect(generationStepKinds({ mode: "full", targetKinds: full }, "carded")).toEqual(["carded"]);
    expect(
      generationStepKinds({ mode: "full", targetKinds: ["summary", "carded"] }, "summary"),
    ).toEqual(["summary"]);
    expect(generationStepKinds({ mode: "single", targetKinds: ["summary"] }, "summary")).toEqual([
      "summary",
    ]);
    // Legacy rows have no frozen target list and keep one kind per step.
    expect(generationStepKinds({ mode: "full", targetKinds: [] }, "summary")).toEqual(["summary"]);
  });

  it("advances past the combined step and skips kinds this run already persisted", () => {
    const full = ["locked_in", "summary", "test_me", "carded"] as const;
    expect(
      nextPendingGenerationStep(full, ["summary", "test_me"], ["locked_in", "summary", "test_me"]),
    ).toBe("carded");
    expect(
      nextPendingGenerationStep(full, ["summary", "test_me"], ["locked_in", "summary"]),
    ).toBe("carded");
    expect(
      nextPendingGenerationStep(["summary", "test_me"], ["summary", "test_me"], ["summary"]),
    ).toBeNull();
    expect(
      nextPendingGenerationStep(full, ["test_me"], ["locked_in", "summary", "carded"]),
    ).toBeNull();
    expect(nextPendingGenerationStep(full, ["locked_in"], ["locked_in"])).toBe("summary");
    expect(firstIncompleteGenerationKind(full, ["locked_in", "summary", "carded"])).toBe("test_me");
    expect(firstIncompleteGenerationKind(full, full)).toBeNull();
  });

  it("reaches 100% only once every targeted kind persisted", () => {
    const targetKinds = ["locked_in", "summary", "test_me", "carded"] as const;
    expect(
      generationProgress({
        targetKinds,
        completedKinds: ["locked_in", "summary", "test_me"],
        status: "running",
      }),
    ).toEqual({ total: 4, completed: 3, percentage: 75, terminal: false });
    expect(
      generationProgress({
        targetKinds,
        completedKinds: ["locked_in", "summary", "carded"],
        status: "partial",
      }),
    ).toEqual({ total: 4, completed: 3, percentage: 75, terminal: true });
    expect(
      generationProgress({ targetKinds, completedKinds: targetKinds, status: "succeeded" }),
    ).toEqual({ total: 4, completed: 4, percentage: 100, terminal: true });
  });
});
