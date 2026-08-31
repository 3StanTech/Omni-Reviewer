import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { manualStaleKinds, selectVisibleGenerationRows } from "@/lib/serialize-view";

const root = path.resolve(__dirname, "..");

describe("generation revision boundaries", () => {
  it("does not rehydrate stale downstream rows during a partial full-run refresh", () => {
    const result = selectVisibleGenerationRows(
      [
        { kind: "locked_in", generationRunId: "run-current" },
        { kind: "summary", generationRunId: "run-current" },
        { kind: "test_me", generationRunId: "run-old" },
        { kind: "carded", generationRunId: "run-old" },
      ],
      {
        mode: "full",
        generationRunId: "run-current",
        step: "test_me",
      },
    );

    expect(result.rows.map((row) => row.kind)).toEqual(["locked_in", "summary"]);
    expect(result.staleKinds).toEqual(["test_me", "carded"]);
    expect(result.currentGenerationRunId).toBe("run-current");
  });

  it("keeps the terminal partial run revision when refreshing after failure", () => {
    const terminalPartialRun = {
      mode: "full" as const,
      generationRunId: "run-terminal-partial",
      step: "test_me",
    };
    const result = selectVisibleGenerationRows(
      [
        { kind: "locked_in", generationRunId: "run-terminal-partial" },
        { kind: "summary", generationRunId: "run-terminal-partial" },
        { kind: "test_me", generationRunId: "run-old" },
        { kind: "carded", generationRunId: "run-old" },
      ],
      terminalPartialRun,
    );

    expect(result.rows.map((row) => row.kind)).toEqual(["locked_in", "summary"]);
    expect(result.staleKinds).toEqual(["test_me", "carded"]);
    expect(result.currentGenerationRunId).toBe("run-terminal-partial");
  });

  it("uses a partial full run as baseline and overlays a later terminal single redo", () => {
    const fullBaseline = {
      mode: "full" as const,
      generationRunId: "run-full-partial",
      step: "test_me",
    };
    const singleRedo = {
      mode: "single" as const,
      generationRunId: "run-single-summary",
      step: "summary",
      active: false,
    };
    const result = selectVisibleGenerationRows(
      [
        { kind: "locked_in", generationRunId: "run-full-partial" },
        { kind: "summary", generationRunId: "run-single-summary" },
        { kind: "test_me", generationRunId: "run-old" },
        { kind: "carded", generationRunId: "run-old" },
      ],
      singleRedo,
      fullBaseline,
    );

    expect(result.rows.map((row) => [row.kind, row.generationRunId])).toEqual([
      ["locked_in", "run-full-partial"],
      ["summary", "run-single-summary"],
    ]);
    expect(result.staleKinds).toEqual(["test_me", "carded"]);
    expect(result.currentGenerationRunId).toBe("run-full-partial");
  });

  it("hides only the mode being replaced during a single-mode redo", () => {
    const result = selectVisibleGenerationRows(
      [
        { kind: "locked_in", generationRunId: "run-old" },
        { kind: "summary", generationRunId: "run-old" },
        { kind: "test_me", generationRunId: "run-old" },
      ],
      {
        mode: "single",
        generationRunId: "run-new",
        step: "summary",
        active: true,
      },
    );

    expect(result.rows.map((row) => row.kind)).toEqual(["locked_in", "test_me"]);
    expect(result.staleKinds).toEqual(["summary"]);
  });

  it("guards publication with the exact active claim and lease", () => {
    const queries = readFileSync(path.join(root, "lib/queries.ts"), "utf8");
    const route = readFileSync(
      path.join(root, "app/api/reviewers/[id]/generation/[jobId]/route.ts"),
      "utf8",
    );

    expect(route).toContain("persistViewForActiveClaim");
    expect(queries).toContain("claim_token = ${args.claimToken}");
    expect(queries).toContain("claim_expires_at > NOW()");
    expect(queries).toContain("RETURNING reviewer_id, generation_run_id");
    expect(queries).toContain("expected_protected");
    expect(queries).toContain("current_protected");
    expect(queries).toContain("FROM views v");
    expect(queries).toContain("FROM cards c2");
    expect(queries).toContain("FOR UPDATE");
  });

  it("keeps learning writes atomic and tenant-scoped", () => {
    const queries = readFileSync(path.join(root, "lib/queries.ts"), "utf8");
    const blob = readFileSync(path.join(root, "lib/blob.ts"), "utf8");

    expect(queries).toContain("CROSS JOIN jsonb_to_recordset(CAST(${JSON.stringify(rows)} AS jsonb))");
    expect(queries).toContain("WITH current_view AS");
    expect(queries).toContain("INSERT INTO card_reviews");
    expect(queries).toContain("INNER JOIN inserted ON inserted.card_id = updated.id");
    expect(queries).toContain("current_protected");
    expect(queries).toContain("expected_protected");
    expect(blob).toContain("assertNamespacedPathname(pathname, owner)");
    expect(blob).toContain("deleteBlobIfUnreferenced(blob.pathname, {");
  });

  it("coordinates source registration with durable reviewer/topic deletion claims", () => {
    const queries = readFileSync(path.join(root, "lib/queries.ts"), "utf8");

    expect(queries).toContain("FOR UPDATE OF r, t");
    expect(queries).toContain("r.deleting_at IS NULL");
    expect(queries).toContain("t.deleting_at IS NULL");
    expect(queries).toContain("deleting_at < NOW() - INTERVAL '15 minutes'");
    expect(queries).toContain("export async function createSourceForOwner");
    expect(queries).toContain("export async function beginReviewerDeletion");
    expect(queries).toContain("export async function beginTopicDeletion");
  });

  it("marks downstream modes stale after a manual Locked In edit", () => {
    const editedAt = new Date("2026-08-30T02:00:00.000Z");
    expect(
      manualStaleKinds([
        { kind: "locked_in", isEdited: true, updatedAt: editedAt },
        { kind: "summary", isEdited: false, updatedAt: new Date("2026-08-30T01:00:00.000Z") },
        { kind: "test_me", isEdited: false, updatedAt: editedAt },
      ]),
    ).toEqual(["summary"]);
  });

  it("does not let a Locked In draft save over a newer revision", () => {
    const editor = readFileSync(path.join(root, "components/locked-in-editor.tsx"), "utf8");
    expect(editor).toContain("const draftIsStale = draftRevision !== revision;");
    expect(editor).toContain("if (draftIsStale)");
    expect(editor).toContain("expectedRevision: revision");
    expect(editor).toContain("Reload the latest content before saving");
  });

  it("does not let a card draft save over a newer revision", () => {
    const editor = readFileSync(path.join(root, "components/carded-view.tsx"), "utf8");
    expect(editor).toContain("const draftIsStale");
    expect(editor).toContain("draftRevision !== card.revision");
    expect(editor).toContain("expectedRevision: draftRevision");
    expect(editor).toContain("This card changed elsewhere");
  });

  it("uses one parser for client card content and durable-card hydration", () => {
    const editor = readFileSync(path.join(root, "components/carded-view.tsx"), "utf8");
    expect(editor).toContain('import { parseCardedItems } from "@/lib/learning"');
    expect(editor).toContain("return parseCardedItems(contentJson, content ?? \"\")");
  });
});
