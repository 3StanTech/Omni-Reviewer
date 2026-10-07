import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("study document interaction contracts", () => {
  it("offers Check again for unsourced claims as well as unchecked claims", () => {
    const document = read("components/study-document.tsx");
    expect(document).toContain("const canRecheck = claims.unsourced > 0 || unchecked > 0;");
    // Check again is a More item registered by the document, not a toolbar button.
    const start = document.indexOf('id: "check-again"');
    expect(start).toBeGreaterThan(-1);
    const item = document.slice(start, document.indexOf("});", start));
    expect(item).toContain('label: checking ? "Checking" : "Check again"');
    expect(item).toContain("disabled: busy || checking || editing");
    expect(item).toContain("onSelect: () => void recheckClaims()");
    expect(document.slice(document.lastIndexOf("if (", start), start)).toContain("canRecheck");
    // The unchecked note describes only unchecked claims and rides on the claims chip.
    const noticeStart = document.indexOf("const uncheckedNote = unchecked > 0 ?");
    expect(noticeStart).toBeGreaterThan(-1);
    const notice = document.slice(noticeStart, document.indexOf("\n", noticeStart));
    expect(notice).toContain("could not be checked");
    expect(notice).not.toContain("Check again");
    expect(document).toContain("title={claimsLabel}");
  });

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

  it("opens the highlight menu only after a drag is released or the selection settles", () => {
    const document = read("components/study-document.tsx");
    const start = document.indexOf("const onSelectionChange = () => {");
    expect(start).toBeGreaterThan(-1);
    const effect = document.slice(start, document.indexOf("}, [captureSelection, captureSelectionNow, editing]);", start));
    // selectionchange is suppressed while a mouse or pen button is down.
    expect(effect).toContain("if (pointerSelectingRef.current) return;");
    // and debounced on a settle timer, not the next animation frame.
    expect(effect).toContain("window.setTimeout(");
    expect(effect).toContain("SELECTION_SETTLE_MS");
    expect(effect).not.toContain("requestAnimationFrame");
    expect(document).toContain("const SELECTION_SETTLE_MS = 350;");
    // Releasing the pointer anywhere captures the final selection once.
    expect(effect).toContain('document.addEventListener("pointerup", onPointerRelease);');
    expect(effect).toContain('document.addEventListener("pointercancel", onPointerRelease);');
    expect(effect).toMatch(/const onPointerRelease = \(\) => \{\s*if \(!pointerSelectingRef\.current\) return;\s*pointerSelectingRef\.current = false;\s*captureSelectionNow\(\);/);
    // A mouse or pen press in the article marks the drag; touch uses the settle timer.
    const article = document.slice(document.indexOf("<article"), document.indexOf("</article>"));
    expect(article).toContain("onPointerDown={(event) => {");
    expect(article).toContain('if (event.pointerType === "touch") return;');
    expect(article).toContain("pointerSelectingRef.current = true;");
    expect(article).not.toContain("onMouseUp");
    expect(article).toContain("onKeyUp={captureSelectionNow}");
    expect(article).toContain("onTouchEnd={captureSelectionNow}");
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

  it("keeps a dirty document draft on this device and restores it after hydration", () => {
    const document = read("components/study-document.tsx");
    expect(document).toContain('from "@/lib/study-draft"');
    expect(document).toContain("studyDraftKey(userId, reviewerId, kind)");
    expect(document).toContain("writeStudyDraft(");
    expect(document).toContain("clearStudyDraft(");
    // The restore reads storage inside an effect, never in initial state.
    expect(document).not.toMatch(/useState\([^)]*readStudyDraft/);
    const restoreEffect = document.slice(document.indexOf("readStudyDraft(storage, draftKey)") - 400, document.indexOf("readStudyDraft(storage, draftKey)"));
    expect(restoreEffect).toContain("useEffect(() => {");
    expect(restoreEffect).toContain("restoreChecked === draftKey");
    // Nothing is cleared or written until the restore check for this key ran.
    expect(document).toContain("if (!draftKey || restoreChecked !== draftKey) return;");
    expect(document).toContain("window.setTimeout(flushDraft, 400)");
    expect(document).toContain('window.addEventListener("pagehide", flushDraft)');
  });

  it("clears the stored draft on Cancel edit, Discard and controller discard", () => {
    const document = read("components/study-document.tsx");
    expect(document).toContain("onClick={() => { if (editing) forgetDraft();");
    expect(document).toMatch(/discard: \(\) => \{\s*forgetDraft\(\);/);
    expect(document).toMatch(/onClick=\{\(\) => \{ forgetDraft\(\); setError\(null\); setDraft\(view\.content\); setDraftRevision\(view\.revision\); setEditing\(false\); \}\}/);
    expect(document).toContain("if (restored && !dirty) setRestored(false);");
  });

  it("clears the stored draft in the save success path before leaving edit mode", () => {
    const document = read("components/study-document.tsx");
    const success = document.slice(document.indexOf("const save = useCallback"), document.indexOf("} catch (caught) {", document.indexOf("const save = useCallback")));
    expect(success).toMatch(/forgetDraft\(\);\s*setEditing\(false\);\s*return true;/);
    expect(document).toMatch(/const save = useCallback[\s\S]*?\[annotations, draftIsStale, earlierCursor, forgetDraft,/);
    expect(document).toMatch(/const forgetDraft = useCallback\(\(\) => \{\s*pendingDraft\.current = null;/);
  });

  it("announces a restored edit with plain copy", () => {
    const document = read("components/study-document.tsx");
    const start = document.indexOf("{restored && editing ? (");
    expect(start).toBeGreaterThan(-1);
    const bar = document.slice(start, document.indexOf("<StudyEditor", start));
    expect(bar).toContain('role="status"');
    expect(bar).toContain("Restored your unsaved edit.");
    expect(bar).toContain("This document changed since this edit. Copy what you need, then Discard.");
    // The stale notice follows the live revision, not a snapshot from restore time.
    expect(bar).toContain("{draftIsStale ? <span");
    expect(bar).not.toContain("restored.stale");
    expect(bar).toContain("Discard");
    expect(bar).toContain("ArrowCounterClockwise");
    expect(bar).not.toContain("—");
  });

  it("mounts citations, the source viewer, Download, and print utilities", () => {
    const document = read("components/study-document.tsx");
    const tabs = read("components/view-tabs.tsx");
    const workspace = read("components/reviewer-workspace.tsx");
    const modal = read("components/source-modal.tsx");
    expect(document).toContain("<StudyExport");
    expect(document).toContain("claims from your sources");
    expect(document).toContain("print-document");
    expect(document).toContain("expectedRevision: view.revision, content");
    expect(document).toContain("resolveUnsourcedClaim");
    expect(tabs).toContain("<SourceViewerProvider");
    expect(tabs).toContain("citationSourcesForMode(views, tab)");
    expect(tabs).toContain("print-hide");
    expect(workspace).toContain('className="print-hide space-y-3" aria-labelledby="generate-heading"');
    expect(modal).toContain('await import("unpdf")');
    expect(modal).not.toMatch(/^import[^\n]*from "unpdf"/m);
    expect(modal).toContain("finalFocus={openerRef}");
    const emDash = "\u2014";
    for (const file of ["components/source-modal.tsx", "components/citation-chip.tsx", "components/unsourced-tag.tsx", "components/study-document.tsx"]) {
      expect(read(file)).not.toContain(emDash);
    }
  });
});
