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
const storedReport = { ...report, unsourced: 0, verifierFailed: true, unchecked: 1, uncheckedKeys: ["12345678"] };
const storedMarkdown = "Claim one [S1 p.1]. Claim two [S1 p.2].";

describe("grounding re-check route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock(auth).mockResolvedValue({ user: { id: "user-1" } });
    mock(getReviewer).mockResolvedValue({ id: "reviewer-1" });
    mock(getViewForReviewer).mockResolvedValue({
      revision: 3,
      content: storedMarkdown,
      contentJson: { citationSources, grounding: storedReport },
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
    expect(mock(regroundStudyDocument)).toHaveBeenCalledTimes(1);
    expect(mock(regroundStudyDocument)).toHaveBeenCalledWith(
      "Claim one [S1 p.1]. Claim two [S1 p.2].",
      [{ index: 1, text: "<<<page 1>>>\nClaim one." }],
      { previous: storedReport },
    );
    expect(mock(updateStudyView)).toHaveBeenCalledWith(expect.objectContaining({
      kind: "locked_in",
      expectedRevision: 3,
      content: "Claim one [S1 p.1]. Claim two [S1 p.2]. [[unsourced]]",
      grounding: report,
    }));
    expect((await response.json()).grounding).toEqual(report);
  });

  it("passes null when there is no stored grounding report", async () => {
    mock(getViewForReviewer).mockResolvedValueOnce({ revision: 3, content: storedMarkdown, contentJson: { citationSources } });
    expect((await POST(request({ expectedRevision: 3 }), context())).status).toBe(200);
    expect(mock(regroundStudyDocument)).toHaveBeenCalledWith(
      storedMarkdown,
      [{ index: 1, text: "<<<page 1>>>\nClaim one." }],
      { previous: null },
    );
  });

  it("returns 503 without saving when verification fails and markdown is unchanged", async () => {
    mock(regroundStudyDocument).mockResolvedValueOnce({ markdown: storedMarkdown, report: { ...storedReport, verifierFailed: true } });

    const response = await POST(request({ expectedRevision: 3 }), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Could not check these claims right now. Try again later." });
    expect(mock(updateStudyView)).not.toHaveBeenCalled();
  });

  it("saves the merged report when verification fails but other claims were improved", async () => {
    const markdown = `${storedMarkdown} [[unsourced]]`;
    const merged = { ...report, lexicalSupported: 2, verifiedSupported: 1, verifierFailed: true, unchecked: 1, uncheckedKeys: ["87654321"] };
    mock(regroundStudyDocument).mockResolvedValueOnce({ markdown, report: merged });

    const response = await POST(request({ expectedRevision: 3 }), context());

    expect(response.status).toBe(200);
    expect(mock(updateStudyView)).toHaveBeenCalledWith(expect.objectContaining({ content: markdown, grounding: merged }));
    expect((await response.json()).grounding).toEqual(merged);
  });

  it("saves the merged report when markdown is unchanged and verification succeeded", async () => {
    const merged = { ...report, unsourced: 0, verifiedSupported: 1 };
    mock(regroundStudyDocument).mockResolvedValueOnce({ markdown: storedMarkdown, report: merged });

    const response = await POST(request({ expectedRevision: 3 }), context());

    expect(response.status).toBe(200);
    expect(mock(updateStudyView)).toHaveBeenCalledWith(expect.objectContaining({ content: storedMarkdown, grounding: merged }));
    expect((await response.json()).grounding).toEqual(merged);
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
