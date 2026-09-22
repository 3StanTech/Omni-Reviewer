import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("study document interaction contracts", () => {
  it("refreshes annotations after saves and preserves the Locked In pin control", () => {
    const document = read("components/study-document.tsx");
    expect(document).toContain("data.view.annotations");
    expect(document).toContain("annotationsNextCursor");
    expect(document).toContain("expectedRevision: view.revision, pinned");
    expect(document).toContain("view.isPinned ? \"Unpin\" : \"Pin\"");
  });

  it("clears stale selection menus and excludes duplicated KaTeX text from offsets", () => {
    const document = read("components/study-document.tsx");
    const index = read("lib/study-dom-text.ts");
    expect(document).toContain("closeSelectionMenu");
    expect(document).toContain("mergeAnnotationRecords");
    expect(document).toContain("annotationRangeCanRender");
    expect(document).not.toContain("index.text !== canonical");
    expect(index).toContain('tagName === "PRE"');
    expect(index).toContain('tagName === "BR"');
    expect(index).toContain("firstDescendant(node, \"annotation\")");
    expect(index).toContain("isSkippedFootnoteSurface");
  });

  it("guards mobile panel focus and Escape return", () => {
    const panel = read("components/study-side-panel.tsx");
    expect(panel).toContain('role="dialog"');
    expect(panel).toContain('event.key === "Escape"');
    expect(panel).toContain("trigger?.focus()");
    expect(panel).toContain("document.activeElement === last");
    expect(panel).toContain("study-side-panel-backdrop");
    expect(panel).toContain("aria-modal={compactSheet}");
  });

  it("guards browser history while a document draft is dirty", () => {
    const workspace = read("components/reviewer-workspace.tsx");
    const guard = read("lib/draft-history-guard.ts");
    expect(workspace).toContain("attachDraftHistoryGuard");
    expect(workspace).toContain("browserSupportsPrecommitHandler");
    expect(workspace).toContain("historyGuardRef.current?.confirm()");
    expect(guard).toContain("precommitHandler");
    expect(guard).not.toContain("event.preventDefault()");
    expect(guard).not.toContain(".pushState(");
  });
});
