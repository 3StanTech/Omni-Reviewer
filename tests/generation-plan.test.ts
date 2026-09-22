import { describe, expect, it } from "vitest";

import {
  generationProgress,
  generationStepDependencies,
  missingGenerationKinds,
  nextGenerationStep,
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
});

