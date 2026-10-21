import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const packet = read("components/packet-document.tsx");
const exportMenu = read("components/study-export.tsx");
const css = read("app/globals.css");

function packetPrintBlock(): string {
  const start = css.indexOf("/* Phase 4: study packet print */");
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start);
}

describe("study packet document", () => {
  it("strips citations and page markers and labels unsourced claims in words", () => {
    expect(packet).toContain("stripCitations(");
    expect(packet).toContain("stripPageMarkers(");
    expect(packet).toContain("UNSOURCED_EXPORT_TEXT");
    expect(packet).toContain("<MarkdownBody");
  });

  it("renders the three sections inside one print document", () => {
    expect(packet).toContain('className="print-document');
    expect(packet).toContain('title="Locked In"');
    expect(packet).toContain('title="Summary"');
    expect(packet).toContain('aria-label="Cards"');
    expect(packet.match(/packet-section/g)?.length).toBeGreaterThanOrEqual(2);
    expect(packet).toContain("Not generated yet");
  });

  it("numbers the cards with cloze blanks and the answer", () => {
    expect(packet).toContain("<ol");
    expect(packet).toContain("packet-card");
    expect(packet).toContain("renderClozeText(card.front)");
    expect(packet).toContain("renderClozeText(card.front, true)");
    expect(packet).toContain("Answer:");
  });
});

describe("study packet print CSS", () => {
  it("keeps rows, display math and cards whole and repeats table headers", () => {
    const block = packetPrintBlock();
    expect(block).toContain("@media print");
    expect(block).toMatch(/\.print-document table\s*\{\s*break-inside: auto;/);
    expect(block).toMatch(
      /\.print-document tr,\s*\.print-document \.katex-display,\s*\.print-document figure,\s*\.packet-card\s*\{\s*break-inside: avoid;/,
    );
    expect(block).toMatch(/\.print-document thead\s*\{\s*display: table-header-group;/);
    expect(block).toMatch(/\.print-document h2,\s*\.print-document h3\s*\{\s*break-after: avoid;/);
    expect(block).toMatch(/\.packet-section \+ \.packet-section\s*\{\s*break-before: page;/);
  });
});

describe("export menu", () => {
  it("downloads the PDFs as files instead of printing", () => {
    expect(exportMenu).toContain("Study packet (PDF)");
    expect(exportMenu).toContain("/api/reviewers/${reviewerId}/pdf?${query}");
    expect(exportMenu).toMatch(/role="menuitem"[^>]*onClick=\{\(\) => void downloadPdf\(kind\)\}/);
    expect(exportMenu).toMatch(/role="menuitem"[^>]*onClick=\{\(\) => void downloadPdf\("packet"\)\}/);
    expect(exportMenu).toContain('exportFilename(reviewerName, label, ".pdf")');
    expect(exportMenu).toContain("Preparing PDF");
    expect(exportMenu).not.toContain("window.print");
    expect(exportMenu).not.toContain("window.open");
  });
});

