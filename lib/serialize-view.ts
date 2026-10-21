export type SerializedView = {
  id: string;
  reviewerId: string;
  kind: string;
  content: string;
  contentJson: unknown | null;
  modelId?: string | null;
  generationRunId?: string | null;
  /** True when this view was produced by the active generation run. */
  stale?: boolean;
  generatedAt: string;
  contentRevision: number;
  annotationRevision: number;
  annotations?: import("@/lib/annotations").AnnotationRecord[];
  annotationsNextCursor?: string | null;
  revision: number;
  isEdited: boolean;
  isPinned: boolean;
  updatedAt: string;
};

export type StudyViewSavePatch = Partial<SerializedView> & {
  staleKinds?: string[];
};

export type ViewsPayload = {
  locked_in: SerializedView | null;
  summary: SerializedView | null;
  test_me: SerializedView | null;
  carded: SerializedView | null;
  /** Active full-run revision, or null when no run is active. */
  currentGenerationRunId?: string | null;
  /** Modes whose persisted rows belong to an older revision. */
  staleKinds?: string[];
};

export type GenerationViewRow = {
  kind: string;
  generationRunId?: string | null;
  [key: string]: unknown;
};

type GenerationVisibilityJob = {
  mode: "full" | "single";
  generationRunId: string;
  step: string | null;
  intent?: "generate_missing" | "redo";
  targetKinds?: string[] | null;
  active?: boolean;
};

/**
 * Run provenance for the persisted rows. The boundary is the latest full
 * replacement run (a full redo, including legacy redo rows); additive
 * missing-mode runs never become a boundary. `currentRunIds` lists the rows'
 * run ids created at or after that boundary, resolved from persisted job
 * order rather than view timestamps.
 */
export type GenerationLineage = {
  boundaryRunId: string | null;
  currentRunIds: readonly string[];
};

function isReplacementRun(job: GenerationVisibilityJob | null | undefined): boolean {
  return job?.mode === "full" && job.intent !== "generate_missing";
}

export function manualStaleKinds(
  rows: Array<{ kind: string; isEdited?: boolean; updatedAt?: Date }>,
): string[] {
  const locked = rows.find((row) => row.kind === "locked_in");
  const stale = new Set<string>();
  if (locked?.isEdited && locked.updatedAt) {
    for (const row of rows) {
      if (row.kind !== "locked_in" && row.updatedAt && row.updatedAt < locked.updatedAt) {
        stale.add(row.kind);
      }
    }
  }
  const summary = rows.find((row) => row.kind === "summary");
  const carded = rows.find((row) => row.kind === "carded");
  // Summary is an upstream source for Carded only. Test Me remains tied to
  // Locked In per the explicit product contract.
  if (summary?.isEdited && summary.updatedAt && carded?.updatedAt && carded.updatedAt < summary.updatedAt) {
    stale.add("carded");
  }
  return [...stale];
}

/**
 * Select rows safe for a normal view refresh. Rows from the latest full
 * replacement run, or from any run after it, stay visible: a later single
 * redo or missing-mode run never hides another run's saved mode. Rows older
 * than that boundary are reported as stale but never returned as content.
 * During an active single-mode redo, the mode being replaced is hidden until
 * the redo commits its row; a missing-mode run shows a target kind only once
 * that run commits it. Without a boundary (legacy or redo-only history) every
 * persisted row, including pre-run rows with no run id, is kept.
 */
export function selectVisibleGenerationRows<T extends GenerationViewRow>(
  rows: T[],
  latestJob?: GenerationVisibilityJob & { completedKinds?: string[] | null } | null,
  lineage?: GenerationLineage | null,
): {
  rows: T[];
  currentGenerationRunId: string | null;
  staleKinds: string[];
} {
  // The latest job, when it is a full replacement, is itself the boundary;
  // this anchors callers that have not resolved lineage.
  const boundaryRunId =
    lineage?.boundaryRunId ??
    (latestJob && isReplacementRun(latestJob) ? latestJob.generationRunId : null);
  if (!latestJob && !boundaryRunId) {
    return { rows, currentGenerationRunId: null, staleKinds: [] };
  }

  const currentRunIds = new Set(lineage?.currentRunIds ?? []);
  if (boundaryRunId) currentRunIds.add(boundaryRunId);
  const missingTargets = new Set(
    latestJob?.intent === "generate_missing"
      ? latestJob.targetKinds?.length
        ? latestJob.targetKinds
        : ["locked_in", "summary", "test_me", "carded"]
      : [],
  );

  const staleKinds = new Set<string>();
  const visibleRows = rows.filter((row) => {
    const runId = row.generationRunId ?? null;
    const fromLatestJob = latestJob != null && runId === latestJob.generationRunId;
    // The boundary always wins: the job only narrows what lineage allows, so
    // no job, current or historical, can re-show replaced content.
    let visible = !boundaryRunId || (runId !== null && currentRunIds.has(runId));
    // A concurrent insert into a missing-mode target is preserved by the
    // persistence CAS and reported as stale rather than shown as this run.
    if (missingTargets.has(row.kind)) visible &&= fromLatestJob;
    if (latestJob?.active && latestJob.mode === "single" && row.kind === latestJob.step) {
      visible &&= fromLatestJob;
    }
    if (!visible) staleKinds.add(row.kind);
    return visible;
  });

  for (const kind of missingTargets) {
    if (!visibleRows.some((row) => row.kind === kind)) staleKinds.add(kind);
  }

  return {
    rows: visibleRows,
    currentGenerationRunId:
      latestJob?.intent === "generate_missing" ? latestJob.generationRunId : boundaryRunId,
    staleKinds: [...staleKinds],
  };
}

export function serializeView(row: {
  id: string;
  reviewerId: string;
  kind: string;
  content: string;
  contentJson: unknown | null;
  modelId?: string | null;
  generationRunId?: string | null;
  stale?: boolean;
  generatedAt: Date;
  revision?: number;
  contentRevision?: number;
  annotationRevision?: number;
  isEdited?: boolean;
  isPinned?: boolean;
  updatedAt?: Date;
}): SerializedView {
  return {
    id: row.id,
    reviewerId: row.reviewerId,
    kind: row.kind,
    content: row.content,
    contentJson: row.contentJson ?? null,
    modelId: row.modelId ?? null,
    generationRunId: row.generationRunId ?? null,
    stale: row.stale ?? false,
    generatedAt: row.generatedAt.toISOString(),
    contentRevision: row.contentRevision ?? row.revision ?? 1,
    annotationRevision: row.annotationRevision ?? 1,
    revision: row.revision ?? 1,
    isEdited: row.isEdited ?? false,
    isPinned: row.isPinned ?? false,
    updatedAt: (row.updatedAt ?? row.generatedAt).toISOString(),
  };
}

export function emptyViewsPayload(): ViewsPayload {
  return {
    locked_in: null,
    summary: null,
    test_me: null,
    carded: null,
    currentGenerationRunId: null,
    staleKinds: [],
  };
}

export function viewsPayloadFromRows(
  rows: Array<{
    id: string;
    reviewerId: string;
    kind: string;
    content: string;
    contentJson: unknown | null;
    modelId?: string | null;
    generationRunId?: string | null;
    stale?: boolean;
    generatedAt: Date;
    revision?: number;
    isEdited?: boolean;
    isPinned?: boolean;
    updatedAt?: Date;
  }>,
  options: {
    currentGenerationRunId?: string | null;
    staleKinds?: string[];
    annotations?: import("@/lib/annotations").AnnotationRecord[];
    annotationNextCursors?: Record<string, string | null>;
  } = {},
): ViewsPayload {
  const byKind = emptyViewsPayload();
  for (const row of rows) {
    const serialized = serializeView(row);
    if (options.annotations) {
      serialized.annotations = options.annotations.filter(
        (annotation) => annotation.viewId === row.id,
      );
    }
    if (options.annotationNextCursors) {
      serialized.annotationsNextCursor = options.annotationNextCursors[row.kind] ?? null;
    }
    if (row.kind === "locked_in") byKind.locked_in = serialized;
    else if (row.kind === "summary") byKind.summary = serialized;
    else if (row.kind === "test_me") byKind.test_me = serialized;
    else if (row.kind === "carded") byKind.carded = serialized;
  }
  byKind.currentGenerationRunId = options.currentGenerationRunId ?? null;
  byKind.staleKinds = options.staleKinds ?? [];
  return byKind;
}
