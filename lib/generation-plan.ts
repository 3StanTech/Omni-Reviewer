/**
 * Pure generation intent, scope, and progress contracts.
 *
 * This module deliberately has no database, provider, or browser imports. It
 * is shared by request parsing, persistence, and client status presentation so
 * every layer agrees on the order and meaning of a generation run.
 */

export const GENERATION_KINDS = [
  "locked_in",
  "summary",
  "test_me",
  "carded",
] as const;

export type GenerateKind = (typeof GENERATION_KINDS)[number];

export type GenerationIntent = "generate_missing" | "redo";

export type GenerationScope = "selected" | "full";

export type GenerationJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial";

export type ExpectedProtectedRevision = {
  key: string;
  revision: number;
};

export type GenerationRequest = {
  intent: GenerationIntent;
  kind?: GenerateKind;
  scope?: GenerationScope;
  forceOverwrite?: boolean;
  expectedProtected?: ExpectedProtectedRevision[];
};

export type ExistingGenerationKinds = Partial<Record<GenerateKind, boolean>>;

export type GenerationPlan = {
  intent: GenerationIntent;
  scope: GenerationScope;
  mode: "full" | "single";
  targetKinds: GenerateKind[];
  initialStep: GenerateKind | null;
  noOp: boolean;
};

export type GenerationProgress = {
  total: number;
  completed: number;
  percentage: number;
  terminal: boolean;
};

export type PersistedGenerationJobShape = {
  mode: "full" | "single";
  step: GenerateKind | null;
  status?: GenerationJobStatus;
  targetKinds?: readonly GenerateKind[] | null;
  completedKinds?: readonly GenerateKind[] | null;
};

export const GENERATION_DEPENDENCIES: Readonly<
  Record<GenerateKind, readonly GenerateKind[]>
> = {
  locked_in: [],
  summary: ["locked_in"],
  test_me: ["locked_in"],
  carded: ["summary"],
};

export function isGenerateKind(value: unknown): value is GenerateKind {
  return typeof value === "string" && GENERATION_KINDS.includes(value as GenerateKind);
}

export function orderedGenerationKinds(kinds: Iterable<GenerateKind>): GenerateKind[] {
  const wanted = new Set(kinds);
  return GENERATION_KINDS.filter((kind) => wanted.has(kind));
}

export function missingGenerationKinds(
  existing: ExistingGenerationKinds,
): GenerateKind[] {
  return GENERATION_KINDS.filter((kind) => existing[kind] !== true);
}

function redoTargets(kind: GenerateKind, scope: GenerationScope): GenerateKind[] {
  if (scope === "full" || kind === "locked_in") return [...GENERATION_KINDS];
  return [kind];
}

/**
 * Plan the ordered target list without consulting mutable application state.
 * The caller must build `existing` from persisted rows; client assertions are
 * not sufficient for deciding what a missing-mode run may replace.
 */
export function planGeneration(args: {
  intent: GenerationIntent;
  kind?: GenerateKind;
  scope?: GenerationScope;
  existing?: ExistingGenerationKinds;
}): GenerationPlan {
  if (args.intent === "generate_missing") {
    const targetKinds = missingGenerationKinds(args.existing ?? {});
    return {
      intent: args.intent,
      scope: "full",
      mode: "full",
      targetKinds,
      initialStep: targetKinds[0] ?? null,
      noOp: targetKinds.length === 0,
    };
  }

  if (!args.kind) {
    throw new Error("Redo requests must name a study mode");
  }
  const scope = args.scope ?? (args.kind === "locked_in" ? "full" : "selected");
  const targetKinds = redoTargets(args.kind, scope);
  return {
    intent: args.intent,
    scope,
    mode: targetKinds.length === 1 ? "single" : "full",
    targetKinds,
    initialStep: targetKinds[0] ?? null,
    noOp: false,
  };
}

export function nextGenerationStep(
  targetKinds: readonly GenerateKind[],
  current: GenerateKind,
): GenerateKind | null {
  const index = targetKinds.indexOf(current);
  return index >= 0 && index + 1 < targetKinds.length
    ? targetKinds[index + 1] ?? null
    : null;
}

export function normalizeCompletedKinds(
  targetKinds: readonly GenerateKind[],
  completedKinds: Iterable<GenerateKind>,
): GenerateKind[] {
  const completed = new Set(completedKinds);
  return targetKinds.filter((kind) => completed.has(kind));
}

/** Reconstruct the original target order for rows written before the scope columns existed. */
export function targetKindsForJob(job: PersistedGenerationJobShape): GenerateKind[] {
  if (job.targetKinds && job.targetKinds.length > 0) {
    return orderedGenerationKinds(job.targetKinds);
  }
  if (job.mode === "single") return job.step ? [job.step] : [];
  return [...GENERATION_KINDS];
}

/** Reconstruct completed steps for legacy rows without falsely marking the active step complete. */
export function completedKindsForJob(job: PersistedGenerationJobShape): GenerateKind[] {
  const targetKinds = targetKindsForJob(job);
  if (job.completedKinds && job.completedKinds.length > 0) {
    return normalizeCompletedKinds(targetKinds, job.completedKinds);
  }
  if (job.status === "succeeded") return targetKinds;
  if (!job.step) return [];
  const activeIndex = targetKinds.indexOf(job.step);
  return activeIndex > 0 ? targetKinds.slice(0, activeIndex) : [];
}

export function generationProgress(args: {
  targetKinds: readonly GenerateKind[];
  completedKinds?: Iterable<GenerateKind>;
  status?: GenerationJobStatus;
}): GenerationProgress {
  const total = args.targetKinds.length;
  const completed = normalizeCompletedKinds(
    args.targetKinds,
    args.completedKinds ?? [],
  ).length;
  const terminal = args.status === "succeeded" || args.status === "failed" || args.status === "partial";
  return {
    total,
    completed,
    percentage: total === 0 ? (terminal ? 100 : 0) : Math.floor((completed / total) * 100),
    terminal,
  };
}

export function generationStepDependencies(
  targetKinds: readonly GenerateKind[],
  step: GenerateKind,
): GenerateKind[] {
  const target = new Set(targetKinds);
  return GENERATION_DEPENDENCIES[step].filter((dependency) => target.has(dependency));
}
