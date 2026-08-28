export type SerializedView = {
  id: string;
  reviewerId: string;
  kind: string;
  content: string;
  contentJson: unknown | null;
  modelId?: string | null;
  generatedAt: string;
};

export type ViewsPayload = {
  locked_in: SerializedView | null;
  summary: SerializedView | null;
  test_me: SerializedView | null;
  carded: SerializedView | null;
};

export function serializeView(row: {
  id: string;
  reviewerId: string;
  kind: string;
  content: string;
  contentJson: unknown | null;
  modelId?: string | null;
  generatedAt: Date;
}): SerializedView {
  return {
    id: row.id,
    reviewerId: row.reviewerId,
    kind: row.kind,
    content: row.content,
    contentJson: row.contentJson ?? null,
    modelId: row.modelId ?? null,
    generatedAt: row.generatedAt.toISOString(),
  };
}

export function emptyViewsPayload(): ViewsPayload {
  return {
    locked_in: null,
    summary: null,
    test_me: null,
    carded: null,
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
    generatedAt: Date;
  }>,
): ViewsPayload {
  const byKind = emptyViewsPayload();
  for (const row of rows) {
    const serialized = serializeView(row);
    if (row.kind === "locked_in") byKind.locked_in = serialized;
    else if (row.kind === "summary") byKind.summary = serialized;
    else if (row.kind === "test_me") byKind.test_me = serialized;
    else if (row.kind === "carded") byKind.carded = serialized;
  }
  return byKind;
}
