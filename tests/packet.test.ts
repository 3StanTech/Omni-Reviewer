import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const page = read("app/topics/[topicId]/reviewers/[reviewerId]/packet/page.tsx");
const packet = read("components/packet-document.tsx");
const exportMenu = read("components/study-export.tsx");
const css = read("app/globals.css");

function packetPrintBlock(): string {
  const start = css.indexOf("/* Phase 4: study packet print */");
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start);
}

describe("study packet page", () => {
  it("requires a session and scopes the topic and pack to the owner", () => {
    expect(page).toContain("await auth()");
    expect(page).toContain('redirect("/login")');
    expect(page).toContain("getTopic(topicId, userId)");
    expect(page).toContain("getReviewer(reviewerId, userId)");
    expect(page).toContain("reviewer.topicId !== topicId");
    expect(page.match(/notFound\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(page).toContain('export const dynamic = "force-dynamic"');
  });

  it("loads the latest Locked In and Summary views and the live cards", () => {
    expect(page).toContain('getViewForReviewer(reviewerId, userId, "locked_in")');
    expect(page).toContain('getViewForReviewer(reviewerId, userId, "summary")');
    expect(page).toContain("getCardsForReviewer(reviewerId, userId)");
    expect(page).not.toContain("AppShell");
  });

  it("has its own loading skeleton without the app shell", () => {
    const loading = read("app/topics/[topicId]/reviewers/[reviewerId]/packet/loading.tsx");
    expect(loading).toContain("Loading study packet");
    expect(loading).toContain("reading-surface");
    expect(loading).not.toContain("AppShell");
  });
});

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

  it("offers a print-hidden toolbar and prints once after fonts load", () => {
    expect(packet).toContain("print-hide");
    expect(packet).toContain("Print or save as PDF");
    expect(packet).toContain("Back to pack");
    expect(packet).toContain("Printer");
    expect(packet).toContain("document.fonts.ready");
    expect(packet).toContain("window.print()");
    expect(page).toContain('print === "1"');
    expect(packet).not.toMatch(/—/);
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
  it("opens the study packet in a new tab ready to print", () => {
    expect(exportMenu).toContain("Study packet (PDF)");
    expect(exportMenu).toContain("/topics/${topicId}/reviewers/${reviewerId}/packet?print=1");
    expect(exportMenu).toContain('"_blank", "noopener"');
    expect(exportMenu).toMatch(/role="menuitem"[^>]*onClick=\{openPacket\}/);
  });
});
