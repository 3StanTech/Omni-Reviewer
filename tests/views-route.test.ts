import { beforeEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({
  getReviewer: vi.fn(),
  updateStudyView: vi.fn(),
  listAnnotationPageForReviewer: vi.fn(),
  getViewForReviewer: vi.fn(),
  loadGroundingSources: vi.fn(),
}));
const ai = vi.hoisted(() => ({ regroundStudyDocument: vi.fn() }));

vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "owner" } }) }));
vi.mock("@/lib/queries", () => queries);
vi.mock("@/lib/ai", () => ai);
vi.mock("@/lib/generation-jobs", () => ({ loadGenerationViews: async () => ({ staleKinds: [] }) }));

import { POST as checkAgain } from "@/app/api/reviewers/[id]/views/[kind]/grounding/route";
import { PATCH } from "@/app/api/reviewers/[id]/views/[kind]/route";
import { PublicError } from "@/lib/public-errors";
import { MAX_STUDY_MARKDOWN_CHARS, MAX_STUDY_MATH_BLOCKS } from "@/lib/study-markdown";

function patch(body: unknown, kind = "locked_in") {
  return PATCH(
    new Request(`http://localhost/api/reviewers/pack/views/${kind}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "pack", kind }) },
  );
}

/** Lecture-shaped Markdown of exactly `length` characters. */
function lecture(length: number): string {
  const head = "# Lecture\n\n";
  return (head + "Example study sentence. ".repeat(Math.ceil(length / 24))).slice(0, length - 1) + ".";
}

describe("study view save", () => {
  beforeEach(() => {
    queries.getReviewer.mockResolvedValue({ id: "pack" });
    queries.updateStudyView.mockImplementation(async (args: { content?: string }) => ({
      id: "view",
      revision: 2,
      contentRevision: 2,
      annotationRevision: 1,
      content: args.content ?? "# Lecture",
      isEdited: true,
      isPinned: false,
      updatedAt: new Date(),
    }));
    queries.listAnnotationPageForReviewer.mockResolvedValue({ annotations: [], nextCursor: null });
  });

  it("saves content of exactly the reader's character limit", async () => {
    const content = lecture(MAX_STUDY_MARKDOWN_CHARS);
    expect(content).toHaveLength(MAX_STUDY_MARKDOWN_CHARS);
    const response = await patch({ expectedRevision: 1, content });
    expect(response.status).toBe(200);
    expect((await response.json()).view.content).toBe(content);
    expect(queries.updateStudyView).toHaveBeenCalledTimes(1);
  });

  it.each(["locked_in", "summary"])("refuses %s content one character past the reader's limit without saving", async (kind) => {
    const response = await patch({ expectedRevision: 1, content: lecture(MAX_STUDY_MARKDOWN_CHARS + 1) }, kind);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "This study content is too long to display (over 100,000 characters).",
    });
    expect(queries.updateStudyView).not.toHaveBeenCalled();
  });

  it("refuses content with more formulas than the reader renders", async () => {
    const content = `# Algebra\n\n${Array.from({ length: MAX_STUDY_MATH_BLOCKS + 1 }, (_, i) => `Step $x_${i}$.`).join("\n")}`;
    const response = await patch({ expectedRevision: 1, content });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/too much math to display safely/);
    expect(queries.updateStudyView).not.toHaveBeenCalled();
  });

  it("checks the trimmed content the route would save", async () => {
    const content = lecture(MAX_STUDY_MARKDOWN_CHARS);
    const response = await patch({ expectedRevision: 1, content: `\n\n${content}   \n` });
    expect(response.status).toBe(200);
    expect(queries.updateStudyView).toHaveBeenCalledWith(expect.objectContaining({ content }));
  });

  it("returns the persistence guard's reason as a 400 when the stored form cannot be displayed", async () => {
    queries.updateStudyView.mockRejectedValueOnce(
      new PublicError("This study content is too long to display (over 100,000 characters)."),
    );
    const response = await patch({ expectedRevision: 1, content: "# Lecture\r\n\r\nExample study sentence." });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "This study content is too long to display (over 100,000 characters).",
    });
  });

  it("still pins without content", async () => {
    const response = await patch({ expectedRevision: 1, pinned: true });
    expect(response.status).toBe(200);
    expect(queries.updateStudyView).toHaveBeenCalledWith(expect.objectContaining({ pinned: true }));
  });
});

describe("Check again", () => {
  beforeEach(() => {
    queries.getReviewer.mockResolvedValue({ id: "pack" });
    queries.getViewForReviewer.mockResolvedValue({ content: "# Lecture\n\nA claim.", contentJson: null, revision: 1 });
    queries.loadGroundingSources.mockResolvedValue([{ id: "source", text: "Source text." }]);
    ai.regroundStudyDocument.mockResolvedValue({
      markdown: "# Lecture\n\nA claim. [[unsourced]]",
      report: { verifierFailed: false },
    });
  });

  it("refuses a re-check whose added tags push the document past what the reader can display", async () => {
    queries.updateStudyView.mockRejectedValueOnce(
      new PublicError("This study content is too long to display (over 100,000 characters)."),
    );
    const response = await checkAgain(
      new Request("http://localhost/api/reviewers/pack/views/locked_in/grounding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1 }),
      }),
      { params: Promise.resolve({ id: "pack", kind: "locked_in" }) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "This study content is too long to display (over 100,000 characters).",
    });
  });
});
