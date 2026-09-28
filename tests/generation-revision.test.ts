import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { manualStaleKinds, selectVisibleGenerationRows } from "@/lib/serialize-view";
import { responseJobId } from "@/lib/use-generation";

const root = path.resolve(__dirname, "..");

type Kind = "locked_in" | "summary" | "test_me" | "carded";
type FakeJob = {
  id: string;
  reviewerId: string;
  userId: string;
  generationRunId: string;
  mode: "full" | "single";
  intent: "generate_missing" | "redo";
  status: string;
  step: Kind | null;
  active: boolean;
  targetKinds: Kind[];
  completedKinds: Kind[];
  upstreamRevisions: Record<string, number>;
  forceOverwrite: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  modelUsed: string | null;
  finishedAt: Date | null;
  claimToken: string | null;
};
type FakeView = {
  kind: Kind;
  generationRunId: string;
  content: string;
  contentJson: unknown;
  revision: number;
  modelId: string;
  generatedAt: Date;
};

const fake = vi.hoisted(() => ({
  job: null as unknown as FakeJob,
  views: new Map<string, FakeView>(),
  staleKinds: new Set<string>(),
  failKinds: new Set<string>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1" } })) }));
vi.mock("@/lib/public-errors", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-errors")>("@/lib/public-errors");
  return { ...actual, logRedactedError: vi.fn() };
});
vi.mock("@/lib/db", () => {
  const chain = () => {
    const node: Record<string, unknown> = {};
    for (const method of ["update", "set", "where", "select", "from", "orderBy"]) {
      node[method] = () => node;
    }
    node.then = (resolve: (value: unknown[]) => unknown) => resolve([]);
    return node;
  };
  return { db: { update: () => chain(), select: () => chain() } };
});
vi.mock("@/lib/generation-jobs", () => ({
  loadGenerationViews: vi.fn(async () => ({})),
  serializeGenerationJob: (job: FakeJob) => ({ ...job }),
}));
vi.mock("@/lib/generation-step", () => ({ runGenerationStep: vi.fn() }));
vi.mock("@/lib/queries", () => {
  const snapshot = () => ({ ...fake.job, completedKinds: [...fake.job.completedKinds] });
  const viewFor = (kind: string, runId?: string) => {
    const view = fake.views.get(kind);
    return view && (!runId || view.generationRunId === runId) ? view : null;
  };
  return {
    getReviewer: vi.fn(async () => ({ id: "reviewer-1" })),
    getGenerationJobForReviewer: vi.fn(async () => snapshot()),
    getLatestFullGenerationJobForReviewer: vi.fn(async () => null),
    reactivateGenerationJobForResume: vi.fn(async () => {
      Object.assign(fake.job, {
        status: "queued",
        active: true,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
      });
      return snapshot();
    }),
    claimGenerationJobStep: vi.fn(async (args: { step: Kind; claimToken: string }) => {
      if (!fake.job.active || fake.job.step !== args.step) return null;
      Object.assign(fake.job, { status: "running", claimToken: args.claimToken });
      return snapshot();
    }),
    getViewForGeneration: vi.fn(async (_reviewerId: string, kind: string, runId: string) =>
      viewFor(kind, runId)),
    getLatestView: vi.fn(async (_reviewerId: string, kind: string) => viewFor(kind)),
    persistViewForActiveClaim: vi.fn(async (args: {
      claimToken: string;
      step: Kind;
      kind?: Kind;
      content: string;
      contentJson: unknown;
      modelUsed: string;
      generatedAt: Date;
      generationRunId: string;
    }) => {
      const kind = args.kind ?? args.step;
      if (fake.job.claimToken !== args.claimToken || fake.job.step !== args.step) return null;
      if (fake.staleKinds.has(kind)) return null;
      const revision = (fake.views.get(kind)?.revision ?? 0) + 1;
      fake.views.set(kind, {
        kind,
        generationRunId: args.generationRunId,
        content: args.content,
        contentJson: args.contentJson,
        revision,
        modelId: args.modelUsed,
        generatedAt: args.generatedAt,
      });
      return revision;
    }),
    updateClaimedGenerationJob: vi.fn(async (_id: string, claimToken: string, patch: Partial<FakeJob>) => {
      if (!fake.job.active || fake.job.claimToken !== claimToken) return null;
      Object.assign(fake.job, patch);
      return snapshot();
    }),
    completeClaimedGenerationJob: vi.fn(async (args: {
      claimToken: string;
      step: Kind;
      completedKinds: Kind[];
      upstreamRevisions: Record<string, number>;
    }) => {
      if (!fake.job.active || fake.job.claimToken !== args.claimToken) return null;
      Object.assign(fake.job, {
        status: "succeeded",
        step: args.step,
        completedKinds: args.completedKinds,
        upstreamRevisions: args.upstreamRevisions,
        active: false,
        claimToken: null,
        errorCode: null,
        errorMessage: null,
      });
      return snapshot();
    }),
    syncGeneratedCards: vi.fn(async () => true),
  };
});

import { POST } from "@/app/api/reviewers/[id]/generation/[jobId]/route";
import { generationProgress } from "@/lib/generation-plan";
import { runGenerationStep } from "@/lib/generation-step";
import { persistViewForActiveClaim, updateClaimedGenerationJob } from "@/lib/queries";

const runStepMock = runGenerationStep as unknown as ReturnType<typeof vi.fn>;
const persistMock = persistViewForActiveClaim as unknown as ReturnType<typeof vi.fn>;
const updateMock = updateClaimedGenerationJob as unknown as ReturnType<typeof vi.fn>;

function seedJob(overrides: Partial<FakeJob> = {}) {
  fake.job = {
    id: "job-1",
    reviewerId: "reviewer-1",
    userId: "user-1",
    generationRunId: "run-1",
    mode: "full",
    intent: "redo",
    status: "running",
    step: "summary",
    active: true,
    targetKinds: ["locked_in", "summary", "test_me", "carded"],
    completedKinds: ["locked_in"],
    upstreamRevisions: { locked_in: 1 },
    forceOverwrite: false,
    errorCode: null,
    errorMessage: null,
    modelUsed: null,
    finishedAt: null,
    claimToken: null,
    ...overrides,
  };
}

function seedView(kind: Kind, generationRunId = "run-1") {
  fake.views.set(kind, {
    kind,
    generationRunId,
    content: kind === "carded" ? "[]" : `# ${kind}`,
    contentJson: kind === "locked_in" || kind === "summary" ? { citationSources: [] } : [],
    revision: 1,
    modelId: "model/free",
    generatedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
}

function generatedStep(step: Kind) {
  const payload = step === "summary"
    ? { kind: step, content: "# Summary" }
    : step === "locked_in"
      ? { kind: step, content: "# Locked In" }
      : { kind: step, content: [{ id: `${step}-1` }] };
  return {
    step,
    payload,
    modelUsed: "model/free",
    meta: step === "summary" ? { citationSources: [] } : undefined,
  };
}

async function post() {
  const response = await POST(new Request("http://localhost/api"), {
    params: Promise.resolve({ id: "reviewer-1", jobId: "job-1" }),
  });
  return { status: response.status, body: (await response.json()) as { status: string } };
}

function generatedKinds(): Kind[] {
  return runStepMock.mock.calls.map((call) => (call[0] as { step: Kind }).step);
}

function persistedKinds(): Kind[] {
  return persistMock.mock.calls.map((call) => {
    const args = call[0] as { step: Kind; kind?: Kind };
    return args.kind ?? args.step;
  });
}

describe("combined Summary and Test Me generation step", () => {
  beforeEach(() => {
    fake.views.clear();
    fake.staleKinds.clear();
    fake.failKinds.clear();
    runStepMock.mockReset();
    persistMock.mockClear();
    updateMock.mockClear();
    runStepMock.mockImplementation(async ({ step }: { step: Kind }) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (fake.failKinds.has(step)) throw new Error(`${step} provider failure`);
      return generatedStep(step);
    });
    seedView("locked_in");
  });

  it("generates Summary and Test Me concurrently under one claim and advances to Carded", async () => {
    seedJob();

    const first = await post();

    expect(first.status).toBe(200);
    expect(generatedKinds().sort()).toEqual(["summary", "test_me"]);
    // Both provider calls start before either result is published.
    expect(Math.max(...runStepMock.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...persistMock.mock.invocationCallOrder),
    );
    expect(persistMock.mock.calls.map((call) => (call[0] as { step: Kind }).step)).toEqual([
      "summary",
      "summary",
    ]);
    expect(persistedKinds()).toEqual(["summary", "test_me"]);
    const claimTokens = new Set(
      persistMock.mock.calls.map((call) => (call[0] as { claimToken: string }).claimToken),
    );
    expect(claimTokens.size).toBe(1);
    expect(fake.job).toMatchObject({
      status: "running",
      step: "carded",
      active: true,
      completedKinds: ["locked_in", "summary", "test_me"],
      upstreamRevisions: { locked_in: 1, summary: 1, test_me: 1 },
      errorCode: null,
    });

    const second = await post();

    expect(second.status).toBe(200);
    expect(generatedKinds().sort()).toEqual(["carded", "summary", "test_me"]);
    expect(fake.job).toMatchObject({
      status: "succeeded",
      completedKinds: ["locked_in", "summary", "test_me", "carded"],
    });
  });

  it("keeps Summary and runs Carded when Test Me fails, then ends partial rather than finished", async () => {
    seedJob();
    fake.failKinds.add("test_me");

    await post();

    expect(persistedKinds()).toEqual(["summary"]);
    expect(fake.job).toMatchObject({
      status: "running",
      step: "carded",
      completedKinds: ["locked_in", "summary"],
      errorCode: "unknown",
    });

    const carded = await post();

    expect(generatedKinds().sort()).toEqual(["carded", "summary", "test_me"]);
    expect(carded.body.status).toBe("partial");
    expect(fake.job).toMatchObject({
      status: "partial",
      step: "test_me",
      active: false,
      completedKinds: ["locked_in", "summary", "carded"],
      errorCode: "unknown",
    });
    expect(
      generationProgress({
        targetKinds: fake.job.targetKinds,
        completedKinds: fake.job.completedKinds,
        status: "partial",
      }),
    ).toEqual({ total: 4, completed: 3, percentage: 75, terminal: true });

    // Resume fills only Test Me and does not repeat Carded.
    fake.failKinds.clear();
    const resumed = await post();

    expect(resumed.body.status).toBe("succeeded");
    expect(generatedKinds().slice(3)).toEqual(["test_me"]);
    expect(fake.job.completedKinds).toEqual(["locked_in", "summary", "test_me", "carded"]);
  });

  it("does not run Carded when Summary fails, but keeps a successful Test Me", async () => {
    seedJob();
    fake.failKinds.add("summary");

    const failed = await post();

    expect(failed.status).toBe(502);
    expect(persistedKinds()).toEqual(["test_me"]);
    expect(fake.job).toMatchObject({
      status: "partial",
      step: "summary",
      active: false,
      completedKinds: ["locked_in", "test_me"],
      upstreamRevisions: { locked_in: 1, test_me: 1 },
    });
    expect(generatedKinds()).not.toContain("carded");

    // Resume regenerates only Summary, then continues to Carded.
    fake.failKinds.clear();
    await post();

    expect(generatedKinds().sort()).toEqual(["summary", "summary", "test_me"]);
    expect(fake.job).toMatchObject({
      status: "running",
      step: "carded",
      completedKinds: ["locked_in", "summary", "test_me"],
    });
  });

  it("returns 409 and writes nothing further when the claim goes stale during the combined persist", async () => {
    seedJob();
    fake.staleKinds.add("summary");

    const stale = await post();

    expect(stale.status).toBe(409);
    expect(persistedKinds()).toEqual(["summary"]);
    expect(fake.views.has("test_me")).toBe(false);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(fake.job).toMatchObject({
      status: "partial",
      step: "summary",
      errorCode: "stale",
      active: false,
      completedKinds: ["locked_in"],
    });
  });

  it("returns 409 when Test Me's publish is stale after Summary persisted", async () => {
    seedJob();
    fake.staleKinds.add("test_me");

    const stale = await post();

    expect(stale.status).toBe(409);
    expect(persistedKinds()).toEqual(["summary", "test_me"]);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(fake.job).toMatchObject({ status: "partial", step: "summary", errorCode: "stale" });
  });

  it("resumes a crashed combined step by generating only the missing kind", async () => {
    seedJob();
    seedView("summary");

    await post();

    expect(generatedKinds()).toEqual(["test_me"]);
    expect(persistedKinds()).toEqual(["test_me"]);
    expect(fake.job).toMatchObject({
      status: "running",
      step: "carded",
      completedKinds: ["locked_in", "summary", "test_me"],
      upstreamRevisions: { locked_in: 1, summary: 1, test_me: 1 },
    });
  });

  it("finishes a crashed combined step without any model call when both kinds persisted", async () => {
    seedJob();
    seedView("summary");
    seedView("test_me");

    await post();

    expect(runStepMock).not.toHaveBeenCalled();
    expect(fake.job).toMatchObject({ step: "carded", completedKinds: ["locked_in", "summary", "test_me"] });
  });

  it("leaves single-mode redo and legacy full jobs one kind per step", async () => {
    seedJob({ mode: "single", targetKinds: ["summary"], completedKinds: [] });

    const single = await post();

    expect(single.body.status).toBe("succeeded");
    expect(generatedKinds()).toEqual(["summary"]);
    expect(fake.job.completedKinds).toEqual(["summary"]);

    runStepMock.mockClear();
    fake.views.delete("summary");
    seedJob({ targetKinds: [], completedKinds: [] });

    await post();

    expect(generatedKinds()).toEqual(["summary"]);
    expect(fake.job).toMatchObject({ status: "running", step: "test_me" });
  });
});

describe("generation revision boundaries", () => {
  it("prefers the server-authoritative winner job id", () => {
    expect(responseJobId({ jobId: "winner", job: null }, "old")).toBe("winner");
    expect(responseJobId({ job: null }, "old")).toBe("old");
  });

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

  it("merges untouched rows with committed missing-mode output", () => {
    const result = selectVisibleGenerationRows(
      [
        { kind: "locked_in", generationRunId: "run-old" },
        { kind: "summary", generationRunId: "run-missing" },
        { kind: "test_me", generationRunId: "run-old" },
      ],
      {
        mode: "full",
        generationRunId: "run-missing",
        step: "test_me",
        intent: "generate_missing",
        targetKinds: ["summary", "carded"],
        active: false,
      },
    );

    expect(result.rows.map((row) => [row.kind, row.generationRunId])).toEqual([
      ["locked_in", "run-old"],
      ["summary", "run-missing"],
      ["test_me", "run-old"],
    ]);
    expect(result.staleKinds).toEqual(["carded"]);
  });

  it("casts the job step through text to view_kind", () => {
    // Postgres has no cast between two enum types; step::view_kind fails at parse time.
    const queries = readFileSync(path.join(root, "lib/queries.ts"), "utf8");
    expect(queries).not.toMatch(/step::view_kind/);
    expect(queries).toContain("valid.step::text::view_kind");
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
    expect(queries).toContain("upstream_revisions");
    expect(queries).toContain("cards_upserted");
    expect(queries).toContain("view_gate");
    expect(queries).toContain("CROSS JOIN view_gate");
    expect(queries).toContain("FROM view_gate");
    expect(queries).toContain("card_write_guard");
    expect(queries).toContain("COUNT(*)::integer - COUNT(*)::integer");
    expect(queries).toContain('code === "22012"');
    expect(queries).toContain("locked_upstream_views AS MATERIALIZED");
    expect(queries).toContain("FOR UPDATE OF upstream");
    expect(queries).toContain("completeClaimedGenerationJob");
    expect(queries).toContain("reviewer_updated AS");
    expect(queries).toContain("CONCAT('card:', c2.source_key)");
    expect(queries).toContain("CONCAT('card:', c.source_key)");
    expect(queries).toContain("already_persisted AS");
    expect(queries).toContain("NOT EXISTS (SELECT 1 FROM already_persisted)");
    expect(queries).toContain("existing_card.source_key");
    expect(queries).not.toContain("protected_card.id::text");
    expect(route).toContain("upstreamRevisions[kind] = persisted");
    expect(route).toContain("generationStepKinds(claimed, step)");
    expect(route).toContain("Promise.allSettled");
    expect(route).toContain("alreadyPersisted.generatedAt");
    expect(route).toContain("completeClaimedGenerationJob");
    expect(route).toContain("syncGeneratedCards");
    expect(route).toContain("reactivateGenerationJobForResume");
    expect(route).toContain("resumed.id !== current.id");
    expect(route).toContain("jobId: job.id");
    expect(queries).toContain('code === "23505"');
    expect(queries).toContain("Re-read this exact row");
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
    expect(editor).toContain("onDirtyChange");
    expect(editor).toContain("controllerRef");
    expect(editor).toContain("key={view.id}");
  });

  it("does not let a card draft save over a newer revision", () => {
    const editor = readFileSync(path.join(root, "components/carded-view.tsx"), "utf8");
    expect(editor).toContain("const draftIsStale");
    expect(editor).toContain("draftRevision !== card.revision");
    expect(editor).toContain("expectedRevision: draftRevision");
    expect(editor).toContain("This card changed elsewhere");
  });

  it("keeps client generation errors and superseded responses visible/safe", () => {
    const controller = readFileSync(path.join(root, "lib/use-generation.ts"), "utf8");
    expect(controller).toContain("activeJobRef");
    expect(controller).toContain("responseJobId");
    expect(controller).toContain("if (responseId !== jobId)");
    expect(controller).toContain("await poll(responseId, data)");
    expect(controller).toContain("activeJobRef.current !== jobId || controller.signal.aborted");
    expect(controller).toContain('status: "failed"');
    expect(controller).toContain("job: null");
    expect(controller).toContain("return jobId ? poll(jobId) : Promise.resolve()");
  });

  it("keeps terminal full runs resumable without inventing a no-op missing run", () => {
    const generateRoute = readFileSync(
      path.join(root, "app/api/reviewers/[id]/generate/route.ts"),
      "utf8",
    );
    const controls = readFileSync(path.join(root, "components/generation-controls.tsx"), "utf8");
    const status = readFileSync(path.join(root, "components/generation-status.tsx"), "utf8");

    expect(generateRoute).toContain("reactivateGenerationJobForResume");
    expect(generateRoute).toContain('latest.status === "partial"');
    expect(controls).toContain("hasTerminalResume");
    expect(controls).toContain("const resumeAllowed = hasReadySource && (hasActiveJob || hasTerminalResume)");
    expect(status).toContain('state.status === "partial"');
  });

  it("invokes the draft save continuation instead of passing the function", () => {
    const workspace = readFileSync(path.join(root, "components/reviewer-workspace.tsx"), "utf8");
    expect(workspace).toContain("onClick={() => void saveDraftAndContinue()}");
  });

  it("uses one parser for client card content and durable-card hydration", () => {
    const editor = readFileSync(path.join(root, "components/carded-view.tsx"), "utf8");
    expect(editor).toContain('import { parseCardedItems } from "@/lib/learning"');
    expect(editor).toContain("return parseCardedItems(contentJson, content ?? \"\")");
  });
});
