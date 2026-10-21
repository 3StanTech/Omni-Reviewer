import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() } }));
vi.mock("@/lib/queries", () => ({
  getTopic: vi.fn(),
  getReviewer: vi.fn(),
  listAnnotationPageForReviewer: vi.fn(),
  getCardsForReviewer: vi.fn(),
}));
vi.mock("@/lib/generation-jobs", () => ({ loadGenerationViews: vi.fn() }));
vi.mock("@/lib/pdf", () => ({ renderPdf: vi.fn(), PdfSignedOutError: class extends Error {} }));

import { auth } from "@/auth";
import type { AnnotationRecord } from "@/lib/annotations";
import { db } from "@/lib/db";
import { loadExportData } from "@/lib/export-data";
import { loadGenerationViews } from "@/lib/generation-jobs";
import { renderPdf } from "@/lib/pdf";
import { getCardsForReviewer, getReviewer, getTopic, listAnnotationPageForReviewer } from "@/lib/queries";
import { buildMarkdownExport, exportFilename, type ExportAnnotation } from "@/lib/study-export";
import { GET as pdfGET } from "@/app/api/reviewers/[id]/pdf/route";
import { StudyPrintDocument } from "@/components/study-print-document";
import { MarkdownBody } from "@/components/study-markdown";

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const SOURCE = [
  "<<<page 1>>>",
  "",
  "## Cells",
  "",
  "Mitochondria make ATP [S1 p.14]. Ribosomes build proteins [S2 pp.3-4].",
  "",
  "Cells dream at night. [[unsourced]]",
].join("\n");

function build(overrides: Partial<Parameters<typeof buildMarkdownExport>[0]> = {}) {
  return buildMarkdownExport({
    title: "Biology",
    modeLabel: "Locked In",
    markdown: SOURCE,
    keepCitations: true,
    includeNotes: false,
    annotations: [],
    ...overrides,
  });
}

describe("buildMarkdownExport", () => {
  it("starts with the title and mode heading", () => {
    expect(build().startsWith("# Biology: Locked In\n\n")).toBe(true);
  });

  it("keeps citations when asked and converts the unsourced token", () => {
    const out = build();
    expect(out).toContain("Mitochondria make ATP [S1 p.14].");
    expect(out).toContain("[S2 pp.3-4]");
    expect(out).toContain("Cells dream at night. (not from your uploaded sources)");
    expect(out).not.toContain("[[unsourced]]");
  });

  it("strips citations but keeps the unsourced note text", () => {
    const out = build({ keepCitations: false });
    expect(out).toContain("Mitochondria make ATP. Ribosomes build proteins.");
    expect(out).not.toMatch(/\[S\d/);
    expect(out).toContain("Cells dream at night. (not from your uploaded sources)");
  });

  it("adds a space before a glued unsourced token", () => {
    const out = build({ markdown: "A claim.[[unsourced]]", keepCitations: false });
    expect(out).toContain("A claim. (not from your uploaded sources)");
  });

  it("strips page markers", () => {
    expect(build()).not.toContain("<<<page");
  });

  it("appends active highlights and notes and excludes archived ones", () => {
    const annotations: ExportAnnotation[] = [
      { quote: "Mitochondria make ATP", note: "Powerhouse.", color: "sun", archivedAt: null },
      { quote: "Line one\nLine two", note: null, color: "sky", archivedAt: null },
      { quote: "Old quote", note: "Old note", color: "rose", archivedAt: "2026-09-01T00:00:00.000Z" },
    ];
    const out = build({ includeNotes: true, annotations });
    expect(out).toContain("## My highlights and notes\n\n> Mitochondria make ATP\n\nPowerhouse.\n\n> Line one\n> Line two\n");
    expect(out).not.toContain("Old quote");
    expect(out).not.toContain("Old note");
  });

  it("omits the notes section when notes are off or none are active", () => {
    const annotations: ExportAnnotation[] = [
      { quote: "Mitochondria", note: "n", color: "sun", archivedAt: null },
    ];
    expect(build({ includeNotes: false, annotations })).not.toContain("My highlights and notes");
    expect(build({
      includeNotes: true,
      annotations: [{ quote: "Gone", note: null, color: "sun", archivedAt: "2026-09-01T00:00:00.000Z" }],
    })).not.toContain("My highlights and notes");
  });
});

describe("exportFilename", () => {
  it("builds name - mode.md", () => {
    expect(exportFilename("Biology 101", "Summary")).toBe("Biology 101 - Summary.md");
    expect(exportFilename("Biology 101", "Study packet", ".pdf")).toBe("Biology 101 - Study packet.pdf");
  });

  it("strips path, control, and reserved characters", () => {
    expect(exportFilename("../bio/chem:\u0000\"x\"<y>|z?*", "Locked In")).toBe("bio chem x y z - Locked In.md");
  });

  it("falls back when the name is empty after cleaning", () => {
    expect(exportFilename("///", "Summary")).toBe("Pack - Summary.md");
  });

  it("caps the filename at 120 characters", () => {
    const name = exportFilename("a".repeat(300), "Summary");
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".md")).toBe(true);
  });
});

const TOPIC_ID = "11111111-1111-1111-1111-111111111111";
const REVIEWER_ID = "22222222-2222-2222-2222-222222222222";

function annotation(id: string, archivedAt: string | null = null): AnnotationRecord {
  return {
    id,
    reviewerId: REVIEWER_ID,
    viewId: "view-1",
    kind: "locked_in" as const,
    contentRevision: 1,
    startOffset: 0,
    endOffset: 4,
    quote: "Cell",
    prefix: "",
    suffix: "",
    color: "sun" as const,
    note: null,
    archivedAt,
    archiveReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function view(kind: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    id: `${kind}-view`,
    reviewerId: REVIEWER_ID,
    kind,
    content,
    contentJson: null,
    generatedAt: "2026-10-01T00:00:00.000Z",
    contentRevision: 1,
    annotationRevision: 1,
    revision: 1,
    isEdited: false,
    isPinned: false,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

/** db.select(...).from(...).where(...).orderBy(...) resolving to the given card rows. */
function cardRows(rows: Array<{ id: string; front: string; back: string }>) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  mocked(db.select).mockReturnValue({ from });
}

describe("loadExportData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked(getTopic).mockResolvedValue({ id: TOPIC_ID, name: "Biology" });
    mocked(getReviewer).mockResolvedValue({ id: REVIEWER_ID, topicId: TOPIC_ID, name: "Cells", deletingAt: null });
    mocked(loadGenerationViews).mockResolvedValue({
      locked_in: view("locked_in", "# Locked In: Cells", { annotations: [annotation("a1")], annotationsNextCursor: "c1" }),
      summary: view("summary", "# Summary: Cells", { annotations: [], annotationsNextCursor: null }),
      test_me: null,
      carded: view("carded", "", {
        contentJson: [
          { id: "card-a", front: "What makes ATP?", back: "Mitochondria" },
          { id: "card-b", front: "What builds proteins?", back: "Ribosomes" },
        ],
      }),
    });
    cardRows([]);
  });

  const load = (overrides: Partial<Parameters<typeof loadExportData>[0]> = {}) => loadExportData({
    topicId: TOPIC_ID,
    reviewerId: REVIEWER_ID,
    userId: "user-1",
    include: { cards: true },
    ...overrides,
  });

  it.each([
    ["another owner's topic", () => mocked(getTopic).mockResolvedValue(null)],
    ["another owner's pack", () => mocked(getReviewer).mockResolvedValue(null)],
    ["a pack in another topic", () => mocked(getReviewer).mockResolvedValue({
      id: REVIEWER_ID, topicId: "33333333-3333-3333-3333-333333333333", name: "Cells", deletingAt: null,
    })],
    ["a pack being deleted", () => mocked(getReviewer).mockResolvedValue({
      id: REVIEWER_ID, topicId: TOPIC_ID, name: "Cells", deletingAt: new Date(),
    })],
  ])("returns nothing for %s and reads no views", async (_label, arrange) => {
    arrange();
    expect(await load()).toBeNull();
    expect(loadGenerationViews).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("reads the views through loadGenerationViews with the owner", async () => {
    const data = await load();
    expect(loadGenerationViews).toHaveBeenCalledWith(REVIEWER_ID, { userId: "user-1" });
    expect(data).toMatchObject({ topicName: "Biology", packName: "Cells" });
    expect(data?.lockedIn?.content).toBe("# Locked In: Cells");
    expect(data?.summary?.content).toBe("# Summary: Cells");
  });

  it("keeps every active annotation and never pages through archived history", async () => {
    mocked(loadGenerationViews).mockResolvedValue({
      locked_in: view("locked_in", "# Locked In: Cells", {
        annotations: [annotation("a1"), annotation("a2"), annotation("old", "2026-09-01T00:00:00.000Z")],
        annotationsNextCursor: "c1",
      }),
      summary: null,
      test_me: null,
      carded: null,
    });
    const data = await load();
    expect(data?.lockedIn?.annotations?.map((item) => item.id)).toEqual(["a1", "a2"]);
    expect(data?.lockedIn?.annotationsNextCursor).toBeNull();
    expect(listAnnotationPageForReviewer).not.toHaveBeenCalled();
  });

  it("projects a pack's never-saved Carded items in memory without inserting cards", async () => {
    const data = await load();
    expect(data?.cards).toEqual([
      { id: "card-a", front: "What makes ATP?", back: "Mitochondria" },
      { id: "card-b", front: "What builds proteins?", back: "Ribosomes" },
    ]);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    expect(getCardsForReviewer).not.toHaveBeenCalled();
  });

  it("prefers the saved active cards", async () => {
    cardRows([{ id: "row-1", front: "Edited front", back: "Edited back" }]);
    const data = await load();
    expect(data?.cards).toEqual([{ id: "row-1", front: "Edited front", back: "Edited back" }]);
  });

  it("skips cards for Locked In and Summary", async () => {
    const data = await load({ include: { cards: false } });
    expect(data?.cards).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("PDF download route", () => {
  const context = { params: Promise.resolve({ id: REVIEWER_ID }) };
  const request = (query: string) => new Request(`https://omni-reviewer.example/api/reviewers/${REVIEWER_ID}/pdf?${query}`, {
    headers: { cookie: "session=abc" },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocked(auth).mockResolvedValue({ user: { id: "user-1" } });
    mocked(getReviewer).mockResolvedValue({ id: REVIEWER_ID, topicId: TOPIC_ID, name: "Cells", deletingAt: null });
    mocked(renderPdf).mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  });

  it.each([
    ["locked_in", `/topics/${TOPIC_ID}/reviewers/${REVIEWER_ID}/print?kind=locked_in`],
    ["summary", `/topics/${TOPIC_ID}/reviewers/${REVIEWER_ID}/print?kind=summary`],
    ["packet", `/topics/${TOPIC_ID}/reviewers/${REVIEWER_ID}/packet`],
  ])("renders %s from its read-only print page, never the pack workspace", async (kind, path) => {
    const response = await pdfGET(request(`kind=${kind}&citations=off&notes=off`), context);
    expect(response.status).toBe(200);
    const input = mocked(renderPdf).mock.calls[0]![0] as { url: URL; bodyData?: Record<string, string> };
    expect(`${input.url.pathname}${input.url.search}`).toBe(path);
    expect(input.url.searchParams.has("mode")).toBe(false);
    if (kind !== "packet") expect(input.bodyData).toEqual({ exportCitations: "off", exportAnnotations: "off" });
  });

  it("answers 404 for a pack being deleted without rendering", async () => {
    mocked(getReviewer).mockResolvedValue({ id: REVIEWER_ID, topicId: TOPIC_ID, name: "Cells", deletingAt: new Date() });
    const response = await pdfGET(request("kind=summary"), context);
    expect(response.status).toBe(404);
    expect(renderPdf).not.toHaveBeenCalled();
  });
});

describe("study print document", () => {
  const render = (annotations: AnnotationRecord[]) => renderToStaticMarkup(createElement(StudyPrintDocument, {
    modeLabel: "Locked In",
    content: "# Locked In: Cells\n\nCells make ATP.",
    annotations,
  }));

  it("lists highlights and notes as plain text in a section the notes toggle hides", () => {
    const html = render([
      { ...annotation("a1"), quote: "Cells make ATP", note: "Ask about <b>glycolysis</b> on page 4" },
      { ...annotation("a2"), quote: "Second line\nof a quote", note: null },
      { ...annotation("blank"), quote: "   ", note: "dropped" },
      { ...annotation("old", "2026-09-01T00:00:00.000Z"), quote: "Old quote", note: "Old note" },
    ]);
    const section = html.slice(html.indexOf("<section"));
    expect(section).toMatch(/^<section data-annotation-note[= >]/);
    expect(section).toContain("My highlights and notes");
    expect(section).toContain("Cells make ATP");
    expect(section).toContain("Ask about &lt;b&gt;glycolysis&lt;/b&gt; on page 4");
    expect(section).not.toContain("<b>");
    expect(section).toContain("Second line\nof a quote");
    expect(section).not.toContain("dropped");
    expect(section).not.toContain("Old quote");
    expect(section).not.toMatch(/—/);
  });

  it("omits the section when nothing is highlighted", () => {
    expect(render([])).not.toContain("My highlights and notes");
  });
});

describe("study Markdown math", () => {
  it("keeps fractions and binomials as MathML fractions", () => {
    const html = renderToStaticMarkup(createElement(MarkdownBody, { source: "Speed is $\\frac{d}{t}$ and $\\binom{n}{k}$." }));
    expect(html).toMatch(/<mfrac><mi>d<\/mi><mi>t<\/mi><\/mfrac>/);
    expect(html).toContain('<mfrac linethickness="0px">');
  });
});
