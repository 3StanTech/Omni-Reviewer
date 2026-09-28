import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/ai", () => ({ regroundStudyDocument: vi.fn() }));
vi.mock("@/lib/generation-jobs", () => ({ loadGenerationViews: vi.fn(async () => ({ staleKinds: [] })) }));
vi.mock("@/lib/queries", () => ({
  getReviewer: vi.fn(),
  getViewForReviewer: vi.fn(),
  listAnnotationPageForReviewer: vi.fn(async () => ({ annotations: [], nextCursor: null })),
  loadGroundingSources: vi.fn(),
  updateStudyView: vi.fn(),
}));
vi.mock("@/lib/public-errors", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-errors")>("@/lib/public-errors");
  return { ...actual, logRedactedError: vi.fn() };
});

import { auth } from "@/auth";
import { regroundStudyDocument } from "@/lib/ai";
import { getReviewer, getViewForReviewer, loadGroundingSources, updateStudyView } from "@/lib/queries";
import { POST } from "@/app/api/reviewers/[id]/views/[kind]/grounding/route";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const context = (kind = "locked_in") => ({ params: Promise.resolve({ id: "reviewer-1", kind }) });
const request = (body: unknown) => new Request("https://omni-reviewer.example", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const citationSources = [{ index: 1, sourceId: "source-1", filename: "pharm.pdf", hasPages: true }];
const report = { total: 2, cited: 2, lexicalSupported: 1, verifiedSupported: 0, unsourced: 1, truncated: false, verifierFailed: false, unchecked: 0 };

describe("grounding re-check route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock(auth).mockResolvedValue({ user: { id: "user-1" } });
    mock(getReviewer).mockResolvedValue({ id: "reviewer-1" });
    mock(getViewForReviewer).mockResolvedValue({
      revision: 3,
      content: "Claim one [S1 p.1]. Claim two [S1 p.2].",
      contentJson: { citationSources, grounding: { ...report, unsourced: 0, verifierFailed: true, unchecked: 1 } },
    });
    mock(loadGroundingSources).mockResolvedValue([{ index: 1, text: "<<<page 1>>>\nClaim one." }]);
    mock(regroundStudyDocument).mockResolvedValue({
      markdown: "Claim one [S1 p.1]. Claim two [S1 p.2]. [[unsourced]]",
      report,
    });
    mock(updateStudyView).mockResolvedValue({
      id: "view-1", revision: 4, contentRevision: 4, annotationRevision: 4,
      content: "Claim one [S1 p.1]. Claim two [S1 p.2]. [[unsourced]]",
      isEdited: false, isPinned: false, updatedAt: new Date("2026-09-28T00:00:00Z"),
    });
  });

  it("re-grounds against the pack's sources and saves the report with the new tags", async () => {
    const response = await POST(request({ expectedRevision: 3 }), context());
    expect(response.status).toBe(200);
    expect(mock(loadGroundingSources)).toHaveBeenCalledWith("reviewer-1", citationSources);
    expect(mock(updateStudyView)).toHaveBeenCalledWith(expect.objectContaining({
      kind: "locked_in",
      expectedRevision: 3,
      content: "Claim one [S1 p.1]. Claim two [S1 p.2]. [[unsourced]]",
      grounding: report,
    }));
    expect((await response.json()).grounding).toEqual(report);
  });

  it("refuses a stale revision without calling the model", async () => {
    const response = await POST(request({ expectedRevision: 2 }), context());
    expect(response.status).toBe(409);
    expect(mock(regroundStudyDocument)).not.toHaveBeenCalled();
  });

  it("is owner-scoped and limited to study documents", async () => {
    mock(getReviewer).mockResolvedValueOnce(null);
    expect((await POST(request({ expectedRevision: 3 }), context())).status).toBe(404);
    expect((await POST(request({ expectedRevision: 3 }), context("carded"))).status).toBe(400);
    expect(mock(regroundStudyDocument)).not.toHaveBeenCalled();
  });
});
