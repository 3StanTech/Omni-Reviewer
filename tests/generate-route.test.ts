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
  clearReviewerQueued: vi.fn(async () => undefined),
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
import {
  clearReviewerQueued,
  createOrReuseGenerationJob,
  getActiveGenerationJobForReviewer,
  getLatestGenerationJobForReviewer,
  reactivateGenerationJobForResume,
} from "@/lib/queries";
import { joinPages, withSlideImageText } from "@/lib/source-markers";

const createJobMock = createOrReuseGenerationJob as unknown as ReturnType<typeof vi.fn>;
const clearQueuedMock = clearReviewerQueued as unknown as ReturnType<typeof vi.fn>;
const activeJobMock = getActiveGenerationJobForReviewer as unknown as ReturnType<typeof vi.fn>;
const latestJobMock = getLatestGenerationJobForReviewer as unknown as ReturnType<typeof vi.fn>;
const reactivateMock = reactivateGenerationJobForResume as unknown as ReturnType<typeof vi.fn>;
const context = { params: Promise.resolve({ id: "reviewer-1" }) };

function generateRequest(query = "") {
  return new Request(`https://omni-reviewer.example/api/reviewers/reviewer-1/generate${query}`, {
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
    expect(clearQueuedMock).not.toHaveBeenCalled();
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

describe("generate route dequeue", () => {
  beforeEach(() => {
    readySources.rows = [{ extractedText: "Cardiac output is stroke volume times heart rate." }];
  });

  it("clears the queue flag once a new job exists", async () => {
    const response = await POST(generateRequest(), context);
    expect(response.status).toBe(200);
    expect(createJobMock).toHaveBeenCalledTimes(1);
    expect(clearQueuedMock).toHaveBeenCalledWith("reviewer-1");
    expect(clearQueuedMock.mock.invocationCallOrder[0])
      .toBeGreaterThan(createJobMock.mock.invocationCallOrder[0]!);
  });

  it("clears the queue flag when a stopped full run is reactivated", async () => {
    latestJobMock.mockResolvedValueOnce({
      id: "job-old",
      mode: "full",
      active: false,
      status: "partial",
      step: "summary",
    });
    reactivateMock.mockResolvedValueOnce({ id: "job-old", mode: "full", status: "queued", step: "summary" });
    const response = await POST(generateRequest(), context);
    expect(response.status).toBe(200);
    expect(createJobMock).not.toHaveBeenCalled();
    expect(clearQueuedMock).toHaveBeenCalledWith("reviewer-1");
  });

  it("keeps a queue-started pack queued while its run is active", async () => {
    const created = await POST(generateRequest("?queue=1"), context);
    expect(created.status).toBe(200);
    expect(createJobMock).toHaveBeenCalledTimes(1);

    latestJobMock.mockResolvedValueOnce({
      id: "job-old",
      mode: "full",
      active: false,
      status: "failed",
      step: "locked_in",
    });
    reactivateMock.mockResolvedValueOnce({ id: "job-old", mode: "full", status: "queued", step: "locked_in" });
    const resumed = await POST(generateRequest("?queue=1"), context);
    expect(resumed.status).toBe(200);
    expect(clearQueuedMock).not.toHaveBeenCalled();
  });

  it("leaves the queue alone on the idempotent active-job return", async () => {
    activeJobMock.mockResolvedValueOnce({ id: "job-live", mode: "full", status: "running", step: "locked_in" });
    const response = await POST(generateRequest(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).jobId).toBe("job-live");
    expect(clearQueuedMock).not.toHaveBeenCalled();
  });
});
