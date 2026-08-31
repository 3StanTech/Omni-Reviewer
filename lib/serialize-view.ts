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
  revision: number;
  isEdited: boolean;
  isPinned: boolean;
  updatedAt: string;
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

export function manualStaleKinds(
  rows: Array<{ kind: string; isEdited?: boolean; updatedAt?: Date }>,
): string[] {
  const locked = rows.find((row) => row.kind === "locked_in");
  if (!locked?.isEdited || !locked.updatedAt) return [];
  const lockedUpdatedAt = locked.updatedAt;
  return rows
    .filter(
      (row) =>
        row.kind !== "locked_in" &&
        row.updatedAt !== undefined &&
        row.updatedAt < lockedUpdatedAt,
    )
    .map((row) => row.kind);
}

/**
 * Select rows safe for a normal view refresh. During a full run, only rows
 * from that run are visible; an older downstream row is reported as stale but
 * never returned as content. During a single-mode redo, hide only the mode
 * currently being replaced.
 */
export function selectVisibleGenerationRows<T extends GenerationViewRow>(
  rows: T[],
  latestJob?: {
    mode: "full" | "single";
    generationRunId: string;
    step: string | null;
    active?: boolean;
  } | null,
  baselineFullJob?: {
    mode: "full";
    generationRunId: string;
    step: string | null;
  } | null,
): {
  rows: T[];
  currentGenerationRunId: string | null;
  staleKinds: string[];
} {
  if (!latestJob) {
    return { rows, currentGenerationRunId: null, staleKinds: [] };
  }

  const staleKinds = new Set<string>();
  const fullJob =
    latestJob.mode === "full" ? latestJob : baselineFullJob ?? null;

  if (!fullJob) {
    // There is no full-run baseline to anchor a single-mode run. Preserve the
    // existing rows rather than inventing a revision boundary.
    return {
      rows: rows.filter((row) => {
        const current = !latestJob.active || row.kind !== latestJob.step;
        if (!current) staleKinds.add(row.kind);
        return current;
      }),
      currentGenerationRunId: null,
      staleKinds: [...staleKinds],
    };
  }

  const baselineRows = rows.filter((row) => {
    const current = row.generationRunId === fullJob.generationRunId;
    if (!current) staleKinds.add(row.kind);
    return current;
  });

  if (latestJob.mode === "full") {
    return {
      rows: baselineRows,
      currentGenerationRunId: fullJob.generationRunId,
      staleKinds: [...staleKinds],
    };
  }

  // A single-mode run is an overlay on the latest full-run baseline. If the
  // redo has not produced a row yet, hide the actively replaced baseline mode
  // but retain it after a terminal failed redo.
  const overlay = rows.find(
    (row) =>
      row.kind === latestJob.step &&
      row.generationRunId === latestJob.generationRunId,
  );
  const visibleRows = baselineRows.filter(
    (row) => !(latestJob.active && row.kind === latestJob.step),
  );
  if (overlay) {
    const existingIndex = visibleRows.findIndex((row) => row.kind === overlay.kind);
    if (existingIndex === -1) visibleRows.push(overlay);
    else visibleRows[existingIndex] = overlay;
  }

  const visibleKinds = new Set(visibleRows.map((row) => row.kind));
  for (const kind of visibleKinds) staleKinds.delete(kind);
  for (const row of rows) {
    if (!visibleKinds.has(row.kind)) staleKinds.add(row.kind);
  }

  return {
    rows: visibleRows,
    currentGenerationRunId: fullJob.generationRunId,
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
  } = {},
): ViewsPayload {
  const byKind = emptyViewsPayload();
  for (const row of rows) {
    const serialized = serializeView(row);
    if (row.kind === "locked_in") byKind.locked_in = serialized;
    else if (row.kind === "summary") byKind.summary = serialized;
    else if (row.kind === "test_me") byKind.test_me = serialized;
    else if (row.kind === "carded") byKind.carded = serialized;
  }
  byKind.currentGenerationRunId = options.currentGenerationRunId ?? null;
  byKind.staleKinds = options.staleKinds ?? [];
  return byKind;
}
