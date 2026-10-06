import { describe, expect, it } from "vitest";

import { buildMarkdownExport, exportFilename, type ExportAnnotation } from "@/lib/study-export";

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
    expect(exportFilename("///", "Summary")).toBe("Reviewer - Summary.md");
  });

  it("caps the filename at 120 characters", () => {
    const name = exportFilename("a".repeat(300), "Summary");
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".md")).toBe(true);
  });
});
