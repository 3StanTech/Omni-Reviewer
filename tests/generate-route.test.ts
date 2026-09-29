import { beforeEach, describe, expect, it, vi } from "vitest";

const readySources = vi.hoisted(() => ({ rows: [] as Array<{ extractedText: string | null }> }));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1" } })) }));
vi.mock("@/lib/db", () => {
  const chain = () => {
    const node: Record<string, unknown> = {};
    for (const method of ["select", "from", "where"]) node[method] = () => node;
    node.then = (resolve: (value: unknown[]) => unknown) => resolve(readySources.rows);
    return node;
  };
  return { db: { select: () => chain() } };
});
vi.mock("@/lib/generation-jobs", () => ({
  loadGenerationViews: vi.fn(async () => ({})),
  serializeGenerationJob: (job: unknown) => job,
}));
vi.mock("@/lib/queries", () => ({
  createOrReuseGenerationJob: vi.fn(async (values: Record<string, unknown>) => ({
    job: { id: "job-1", ...values },
  })),
  getActiveGenerationJobForReviewer: vi.fn(async () => null),
  getGenerationExistingKinds: vi.fn(async () => ({})),
  getGenerationUpstreamRevisions: vi.fn(async () => ({})),
  getLatestFullGenerationJobForReviewer: vi.fn(async () => null),
  getLatestGenerationJobForReviewer: vi.fn(async () => null),
  getLatestView: vi.fn(async () => null),
  getReviewer: vi.fn(async () => ({ id: "reviewer-1" })),
  protectedContentForGeneration: vi.fn(async () => []),
  reactivateGenerationJobForResume: vi.fn(async () => null),
}));

import { POST } from "@/app/api/reviewers/[id]/generate/route";
import { createOrReuseGenerationJob } from "@/lib/queries";
import { joinPages, withSlideImageText } from "@/lib/source-markers";

const createJobMock = createOrReuseGenerationJob as unknown as ReturnType<typeof vi.fn>;
const context = { params: Promise.resolve({ id: "reviewer-1" }) };

function generateRequest() {
  return new Request("https://omni-reviewer.example/api/reviewers/reviewer-1/generate", {
    method: "POST",
    body: JSON.stringify({ intent: "generate_missing" }),
  });
}

describe("generate route source gate", () => {
  beforeEach(() => {
    readySources.rows = [];
  });

  it.each([
    ["no ready sources", []],
    ["a scanned PDF that is not read yet", [{ extractedText: joinPages(["", "", ""]) }]],
    ["slides read as having no readable content", [{ extractedText: joinPages([withSlideImageText("", "")]) }]],
    ["a whitespace-only source", [{ extractedText: "  " }]],
  ])("refuses to start a pack from %s", async (_label, rows) => {
    readySources.rows = rows;
    const response = await POST(generateRequest(), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/No ingested sources/);
    expect(body.error).not.toContain("—");
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it("starts a pack once a slide image has been read", async () => {
    readySources.rows = [
      { extractedText: joinPages(["", ""]) },
      { extractedText: joinPages(["", withSlideImageText("", "Diagram of an AM envelope")]) },
    ];
    const response = await POST(generateRequest(), context);
    expect(response.status).toBe(200);
    expect(createJobMock).toHaveBeenCalledTimes(1);
  });
});
