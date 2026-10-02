"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ArrowCounterClockwise, Presentation, SealCheck } from "@phosphor-icons/react";

import { AnnotationMenu } from "@/components/annotation-menu";
import { StudyEditor } from "@/components/study-editor";
import { MarkdownBody } from "@/components/study-markdown";
import { SOURCE_LIST_UNAVAILABLE, useSourceViewer } from "@/components/source-modal";
import { StudyExport } from "@/components/study-export";
import { UnsourcedActionsProvider } from "@/components/unsourced-tag";
import {
  countClaims,
  parseCitations,
  readStudyDocumentMeta,
  resolveUnsourcedClaim,
  unsourcedTokenOffsets,
  type UnsourcedResolution,
} from "@/lib/citations";
import type { LockedInDraftController } from "@/components/locked-in-editor";
import {
  annotationRangeCanRender,
  annotationRangesOverlap,
  contextForRange,
  mergeAnnotationRecords,
  nextEarlierCursorAfterMerge,
  renderedStudyText,
  type AnnotationColor,
  type AnnotationRecord,
} from "@/lib/annotations";
import type { SerializedView, StudyViewSavePatch } from "@/lib/serialize-view";
import { buildStudyDomTextIndex, rangeOffsetsForStudyDom } from "@/lib/study-dom-text";
import { readApiError } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StudySidePanel } from "@/components/study-side-panel";
import { readReadingPosition, readingPositionKey, writeReadingPosition } from "@/lib/reading-position";
import { getLocalStorage } from "@/lib/safe-storage";
import { clearStudyDraft, readStudyDraft, studyDraftKey, writeStudyDraft, type StudyDraft } from "@/lib/study-draft";

type StudyDocumentProps = {
  userId?: string;
  reviewerId: string;
  kind: "locked_in" | "summary";
  view: SerializedView;
  onSaved: (patch: StudyViewSavePatch) => void;
  onDirtyChange?: (dirty: boolean) => void;
  controllerRef?: MutableRefObject<LockedInDraftController | null>;
};

/** Pack-level details a study document needs but its mode views do not pass down. */
export const StudyPackContext = createContext<{ reviewerName: string }>({ reviewerName: "" });

const UNSOURCED_MISMATCH_MESSAGE =
  "Could not match this tag to the saved document. Use Edit to change the sentence.";

/** Selection-driven capture waits until the selection has stopped changing (touch handles, shift+arrows). */
const SELECTION_SETTLE_MS = 350;

const UNSUPPORTED_RANGE_MESSAGE =
  "That selection includes math, a code block, or a footnote that cannot be highlighted. Select ordinary study text, or a whole inline code/math span.";

function applyIncomingAnnotations(
  current: AnnotationRecord[],
  incoming: AnnotationRecord[] | undefined,
  incomingCursor: string | null | undefined,
  currentCursor: string | null,
): { annotations: AnnotationRecord[]; earlierCursor: string | null } {
  const nextIncoming = incoming ?? [];
  return {
    annotations: mergeAnnotationRecords(current, nextIncoming),
    earlierCursor: nextEarlierCursorAfterMerge(currentCursor, incomingCursor, current, nextIncoming),
  };
}

export function StudyDocument({ userId, reviewerId, kind, view, onSaved, onDirtyChange, controllerRef }: StudyDocumentProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.content);
  const [draftRevision, setDraftRevision] = useState(view.revision);
  const [annotations, setAnnotations] = useState(view.annotations ?? []);
  const [earlierCursor, setEarlierCursor] = useState(view.annotationsNextCursor ?? null);
  const [earlierBusy, setEarlierBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ quote: string; startOffset: number; endOffset: number; prefix: string; suffix: string } | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<{ top: number; left: number } | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const selectionOpenRef = useRef(false);
  // A mouse or pen drag that started in the article; selectionchange waits for its release.
  const pointerSelectingRef = useRef(false);
  const selectionSettleTimer = useRef<number | undefined>(undefined);
  const { reviewerName } = useContext(StudyPackContext);
  const { openSource, available: sourcesAvailable } = useSourceViewer();
  const modeLabel = kind === "summary" ? "Summary" : "Locked In";
  const claims = useMemo(() => countClaims(view.content), [view.content]);
  const firstCitation = useMemo(() => parseCitations(view.content)[0] ?? null, [view.content]);
  // Only a grounded document can say how many claims came from the sources:
  // every claim without an unsourced tag passed the lexical or model check.
  const grounding = useMemo(() => readStudyDocumentMeta(view.contentJson)?.grounding ?? null, [view.contentJson]);
  const grounded = Boolean(grounding);
  const showClaimCount = grounded && claims.total > 0;
  // Claims the verifier could not reach are neither confirmed nor tagged.
  const unchecked = Math.min(grounding?.unchecked ?? 0, Math.max(0, claims.total - claims.unsourced));
  // Tagged or unchecked claims can both be sent back through the checker.
  const canRecheck = claims.unsourced > 0 || unchecked > 0;
  const [checking, setChecking] = useState(false);
  const viewIdentity = `${view.id}:${view.contentRevision}:${view.annotationRevision}`;
  const [appliedIdentity, setAppliedIdentity] = useState(viewIdentity);
  const draftIsStale = draftRevision !== view.revision;
  const dirty = editing && draft !== view.content;
  if (viewIdentity !== appliedIdentity) {
    setAppliedIdentity(viewIdentity);
    const incoming = view.annotations ?? [];
    setAnnotations(mergeAnnotationRecords(annotations, incoming));
    setEarlierCursor(nextEarlierCursorAfterMerge(
      earlierCursor,
      view.annotationsNextCursor,
      annotations,
      incoming,
    ));
    setSelection(null);
    setSelectionAnchor(null);
    if (!dirty) {
      setDraft(view.content);
      setDraftRevision(view.revision);
    }
  } else if (!dirty && (draft !== view.content || draftRevision !== view.revision)) {
    setDraft(view.content);
    setDraftRevision(view.revision);
  }
  // A dirty edit is kept on this device so it survives Back/Forward, reload and
  // iOS tab eviction, where the history guard cannot intercept navigation.
  const draftKey = userId ? studyDraftKey(userId, reviewerId, kind) : null;
  // State, not a ref: the first clean render (and its StrictMode re-run) must
  // never erase a stored draft before the restore effect has read it.
  const [restoreChecked, setRestoreChecked] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  if (restored && !dirty) setRestored(false);
  const pendingDraft = useRef<{ key: string; draft: StudyDraft } | null>(null);
  const flushDraft = useCallback(() => {
    const pending = pendingDraft.current;
    if (!pending) return;
    pendingDraft.current = null;
    writeStudyDraft(getLocalStorage(), pending.key, pending.draft);
  }, []);
  const forgetDraft = useCallback(() => {
    pendingDraft.current = null;
    if (draftKey) clearStudyDraft(getLocalStorage(), draftKey);
  }, [draftKey]);
  const closeSelectionMenu = useCallback(() => {
    setSelection(null);
    setSelectionAnchor(null);
    window.requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    selectionOpenRef.current = selection !== null;
  }, [selection]);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!draftKey || restoreChecked !== draftKey) return;
    if (!dirty) {
      forgetDraft();
      return;
    }
    pendingDraft.current = { key: draftKey, draft: { content: draft, baseRevision: draftRevision, savedAt: Date.now() } };
    const timer = window.setTimeout(flushDraft, 400);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, draftKey, draftRevision, flushDraft, forgetDraft, restoreChecked]);
  useEffect(() => {
    if (!draftKey || restoreChecked === draftKey) return;
    // Restore after hydration so the server and first client render match.
    const frame = window.requestAnimationFrame(() => {
      const storage = getLocalStorage();
      const stored = readStudyDraft(storage, draftKey);
      if (stored && stored.content !== view.content) {
        setDraft(stored.content);
        setDraftRevision(stored.baseRevision);
        setEditing(true);
        setRestored(true);
      } else if (stored) {
        clearStudyDraft(storage, draftKey);
      }
      setRestoreChecked(draftKey);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draftKey, restoreChecked, view.content]);
  useEffect(() => {
    // Write the last keystrokes when the page is hidden or the document unmounts.
    window.addEventListener("pagehide", flushDraft);
    return () => { window.removeEventListener("pagehide", flushDraft); flushDraft(); };
  }, [flushDraft]);
  useEffect(() => {
    if (!userId || !articleRef.current) return;
    const key = readingPositionKey(userId, reviewerId, kind, view.contentRevision);
    const storage = getLocalStorage();
    const saved = readReadingPosition(storage, key);
    const restore = () => {
      if (!saved) return;
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: max * saved.offset, behavior: "auto" });
    };
    const restoreFrame = window.requestAnimationFrame(restore);
    let timer: number | undefined;
    const currentHeadingId = () => {
      const headings = articleRef.current?.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]");
      if (!headings) return null;
      let visible: string | null = null;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= 128) visible = heading.id;
        else break;
      }
      return visible;
    };
    const remember = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        writeReadingPosition(storage, key, { headingId: currentHeadingId(), offset: Math.min(1, Math.max(0, window.scrollY / max)) });
      }, 200);
    };
    window.addEventListener("scroll", remember, { passive: true });
    return () => { window.cancelAnimationFrame(restoreFrame); window.removeEventListener("scroll", remember); if (timer) window.clearTimeout(timer); };
  }, [kind, reviewerId, userId, view.contentRevision]);

  const save = useCallback(async (content: string): Promise<boolean> => {
    if (draftIsStale) {
      setError("This document changed elsewhere. Reload the latest content before saving.");
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/views/${kind}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: view.revision, content }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as {
        view: Partial<SerializedView>;
        staleKinds?: string[];
      };
      const merged = applyIncomingAnnotations(
        annotations,
        Array.isArray(data.view.annotations) ? data.view.annotations : undefined,
        data.view.annotationsNextCursor,
        earlierCursor,
      );
      setAnnotations(merged.annotations);
      setEarlierCursor(merged.earlierCursor);
      onSaved({
        ...data.view,
        annotations: merged.annotations,
        annotationsNextCursor: merged.earlierCursor,
        staleKinds: data.staleKinds,
      });
      if (typeof data.view.revision === "number") setDraftRevision(data.view.revision);
      // Clear now: a save-and-continue can unmount this document before the
      // not-dirty effect runs, and the unmount flush must have nothing to write.
      forgetDraft();
      setEditing(false);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not save ${kind === "summary" ? "Summary" : "Locked In"}.`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [annotations, draftIsStale, earlierCursor, forgetDraft, kind, onSaved, reviewerId, view.revision]);

  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      save: () => save(draft),
      discard: () => {
        forgetDraft();
        setDraft(view.content);
        setDraftRevision(view.revision);
        setEditing(false);
        setError(null);
        setAnnotations(view.annotations ?? []);
        setEarlierCursor(view.annotationsNextCursor ?? null);
      },
    };
    return () => { controllerRef.current = null; };
  }, [controllerRef, draft, forgetDraft, save, view.annotations, view.annotationsNextCursor, view.content, view.revision]);

  const resolveUnsourced = useCallback(async (occurrence: number, action: UnsourcedResolution): Promise<boolean> => {
    if (editing || busy) return false;
    const rendered = articleRef.current?.querySelectorAll(".study-unsourced").length ?? -1;
    if (rendered !== unsourcedTokenOffsets(view.content).length) {
      setError(UNSOURCED_MISMATCH_MESSAGE);
      return false;
    }
    const next = resolveUnsourcedClaim(view.content, occurrence, action);
    if (next === null || !next.trim()) {
      setError(next === null ? UNSOURCED_MISMATCH_MESSAGE : `Deleting this sentence would leave ${modeLabel} empty. Use Edit instead.`);
      return false;
    }
    return save(next);
  }, [busy, editing, modeLabel, save, view.content]);
  const unsourcedActions = useMemo(
    () => ({
      resolve: resolveUnsourced,
      disabled: editing || busy,
      checkIncomplete: Boolean(grounding?.verifierFailed || grounding?.truncated),
    }),
    [busy, editing, grounding, resolveUnsourced],
  );

  const captureSelection = useCallback(() => {
    if (editing || !articleRef.current) {
      closeSelectionMenu();
      return;
    }
    const currentSelection = window.getSelection();
    if (!currentSelection || currentSelection.rangeCount === 0 || currentSelection.isCollapsed) {
      if (document.activeElement?.closest(".annotation-menu")) return;
      // A click on a citation chip or unsourced tag collapses the selection;
      // only close (and refocus the article) when a highlight menu is open.
      if (!selectionOpenRef.current) return;
      closeSelectionMenu();
      return;
    }
    const range = currentSelection.getRangeAt(0);
    if (!articleRef.current.contains(range.startContainer) || !articleRef.current.contains(range.endContainer)) {
      closeSelectionMenu();
      return;
    }
    const index = buildStudyDomTextIndex(articleRef.current);
    const canonical = renderedStudyText(view.content);
    const offsets = rangeOffsetsForStudyDom(articleRef.current, range, index);
    if (!offsets) {
      closeSelectionMenu();
      return;
    }
    let { startOffset, endOffset } = offsets;
    if (endOffset > canonical.length || startOffset < 0) {
      closeSelectionMenu();
      setError(UNSUPPORTED_RANGE_MESSAGE);
      return;
    }
    const indexedQuote = index.text.slice(startOffset, endOffset);
    while (startOffset < endOffset && /\s/u.test(canonical[startOffset] ?? "")) startOffset += 1;
    while (endOffset > startOffset && /\s/u.test(canonical[endOffset - 1] ?? "")) endOffset -= 1;
    const quote = canonical.slice(startOffset, endOffset);
    if (!quote || indexedQuote.trim() !== quote.trim()) {
      closeSelectionMenu();
      setError(UNSUPPORTED_RANGE_MESSAGE);
      return;
    }
    if (!annotationRangeCanRender(view.content, startOffset, endOffset)) {
      closeSelectionMenu();
      setError(UNSUPPORTED_RANGE_MESSAGE);
      return;
    }
    if (annotations.some((annotation) => !annotation.archivedAt && annotationRangesOverlap(annotation, { startOffset, endOffset }))) {
      closeSelectionMenu();
      setError("That selection overlaps an existing highlight. Select a separate range.");
      return;
    }
    const context = contextForRange(canonical, startOffset, endOffset);
    const articleRect = articleRef.current.getBoundingClientRect();
    const selectionRect = range.getBoundingClientRect();
    const estimatedMenuHeight = 190;
    const topBelow = selectionRect.bottom - articleRect.top + 8;
    const topAbove = selectionRect.top - articleRect.top - estimatedMenuHeight;
    const top = topAbove >= 8 ? topAbove : topBelow;
    const left = Math.min(
      Math.max(8, selectionRect.left - articleRect.left),
      Math.max(8, articleRect.width - 360),
    );
    setError(null);
    setSelectionAnchor({ top, left });
    setSelection({ quote, startOffset, endOffset, ...context });
  }, [annotations, closeSelectionMenu, editing, view.content]);

  /** Capture once now, dropping any pending settle-timer capture. */
  const captureSelectionNow = useCallback(() => {
    window.clearTimeout(selectionSettleTimer.current);
    selectionSettleTimer.current = undefined;
    captureSelection();
  }, [captureSelection]);

  useEffect(() => {
    if (editing) return;
    const onSelectionChange = () => {
      window.clearTimeout(selectionSettleTimer.current);
      selectionSettleTimer.current = undefined;
      // Mid-drag selections are partial; the release captures the final one.
      if (pointerSelectingRef.current) return;
      selectionSettleTimer.current = window.setTimeout(() => {
        selectionSettleTimer.current = undefined;
        captureSelection();
      }, SELECTION_SETTLE_MS);
    };
    const onPointerRelease = () => {
      if (!pointerSelectingRef.current) return;
      pointerSelectingRef.current = false;
      captureSelectionNow();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerup", onPointerRelease);
    document.addEventListener("pointercancel", onPointerRelease);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerup", onPointerRelease);
      document.removeEventListener("pointercancel", onPointerRelease);
      window.clearTimeout(selectionSettleTimer.current);
      selectionSettleTimer.current = undefined;
      pointerSelectingRef.current = false;
    };
  }, [captureSelection, captureSelectionNow, editing]);

  useEffect(() => {
    if (!selection) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest(".annotation-menu")) return;
      closeSelectionMenu();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closeSelectionMenu, selection]);

  async function recheckClaims() {
    setChecking(true);
    setError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/views/${kind}/grounding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: view.revision }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as {
        grounding: NonNullable<typeof grounding>;
        view: Partial<SerializedView>;
        staleKinds?: string[];
      };
      const merged = applyIncomingAnnotations(
        annotations,
        Array.isArray(data.view.annotations) ? data.view.annotations : undefined,
        data.view.annotationsNextCursor,
        earlierCursor,
      );
      setAnnotations(merged.annotations);
      setEarlierCursor(merged.earlierCursor);
      const meta = view.contentJson && typeof view.contentJson === "object" ? view.contentJson : {};
      onSaved({
        ...data.view,
        contentJson: { ...meta, grounding: data.grounding },
        annotations: merged.annotations,
        annotationsNextCursor: merged.earlierCursor,
        staleKinds: data.staleKinds,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not check these claims.");
    } finally {
      setChecking(false);
    }
  }

  async function saveAnnotation(color: AnnotationColor, note: string | null): Promise<boolean> {
    if (!selection) return false;
    setError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          expectedRevision: view.revision,
          expectedContentRevision: view.contentRevision,
          expectedAnnotationRevision: view.annotationRevision,
          annotations: [{ ...selection, color, note }],
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as {
        annotations: AnnotationRecord[];
        nextCursor?: string | null;
        viewRevision: number;
        contentRevision: number;
        annotationRevision: number;
      };
      const merged = applyIncomingAnnotations(annotations, data.annotations, data.nextCursor, earlierCursor);
      setAnnotations(merged.annotations);
      setEarlierCursor(merged.earlierCursor);
      onSaved({
        revision: data.viewRevision,
        contentRevision: data.contentRevision,
        annotationRevision: data.annotationRevision,
        annotations: merged.annotations,
        annotationsNextCursor: merged.earlierCursor,
      });
      window.getSelection()?.removeAllRanges();
      closeSelectionMenu();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this annotation.");
      return false;
    }
  }

  async function loadEarlier() {
    if (!earlierCursor || earlierBusy) return;
    setEarlierBusy(true);
    try {
      const query = new URLSearchParams({ kind, scope: "earlier", cursor: earlierCursor });
      const response = await fetch(`/api/reviewers/${reviewerId}/annotations?${query.toString()}`);
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { annotations: AnnotationRecord[]; nextCursor: string | null };
      setAnnotations((current) => {
        const seen = new Set(current.map((annotation) => annotation.id));
        return [...current, ...data.annotations.filter((annotation) => !seen.has(annotation.id))];
      });
      setEarlierCursor(data.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load Earlier version history.");
    } finally {
      setEarlierBusy(false);
    }
  }

  async function togglePinned() {
    if (kind !== "locked_in" || editing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/views/${kind}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: view.revision, pinned: !view.isPinned }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { view: Partial<SerializedView>; staleKinds?: string[] };
      const merged = applyIncomingAnnotations(
        annotations,
        Array.isArray(data.view.annotations) ? data.view.annotations : undefined,
        data.view.annotationsNextCursor,
        earlierCursor,
      );
      setAnnotations(merged.annotations);
      setEarlierCursor(merged.earlierCursor);
      onSaved({
        ...data.view,
        annotations: merged.annotations,
        annotationsNextCursor: merged.earlierCursor,
        staleKinds: data.staleKinds,
      });
      if (typeof data.view.revision === "number") setDraftRevision(data.view.revision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the Locked In pin.");
    } finally {
      setBusy(false);
    }
  }

  const activeAnnotations = annotations.filter((annotation) => !annotation.archivedAt);
  const earlierAnnotations = annotations.filter((annotation) => annotation.archivedAt);
  return (
    <div className="space-y-3">
      {showClaimCount ? (
        <div className="print-hide flex flex-wrap items-center gap-2">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-foreground">
            <SealCheck weight="bold" className="size-3.5 text-primary" aria-hidden />
            {claims.total - claims.unsourced - unchecked} of {claims.total} claims from your sources
          </p>
          {unchecked > 0 ? (
            <p className="text-xs text-muted-foreground">
              {unchecked} {unchecked === 1 ? "claim" : "claims"} could not be checked
            </p>
          ) : null}
          {canRecheck ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void recheckClaims()} disabled={busy || checking || editing}>
              {checking ? "Checking" : "Check again"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!editing ? (
        <StudySidePanel
          markdown={view.content}
          annotations={annotations}
          earlierCursor={earlierCursor}
          earlierBusy={earlierBusy}
          onLoadEarlier={() => void loadEarlier()}
        />
      ) : null}
      <div className="print-hide flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => { if (editing) forgetDraft(); setError(null); setDraft(view.content); setDraftRevision(view.revision); setSelection(null); setSelectionAnchor(null); setEditing((current) => !current); }} disabled={busy}>
          {editing ? "Cancel edit" : `Edit ${kind === "summary" ? "Summary" : "Locked In"}`}
        </Button>
        {kind === "locked_in" && !editing ? <Button type="button" variant="outline" size="sm" onClick={() => void togglePinned()} disabled={busy}>{view.isPinned ? "Unpin" : "Pin"}</Button> : null}
        {!editing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={!sourcesAvailable || !firstCitation}
            title={!sourcesAvailable ? SOURCE_LIST_UNAVAILABLE : !firstCitation ? "This version has no source citations." : "Open the first cited page"}
            className={!sourcesAvailable || !firstCitation ? "cursor-not-allowed opacity-50" : undefined}
            onClick={() => {
              if (!sourcesAvailable || !firstCitation) return;
              openSource({ source: firstCitation.source, page: firstCitation.pageStart });
            }}
          >
            <Presentation />
            Sources
          </Button>
        ) : null}
        {!editing ? (
          <StudyExport reviewerName={reviewerName || modeLabel} modeLabel={modeLabel} markdown={view.content} annotations={annotations} />
        ) : null}
        {editing ? <Button type="button" size="sm" onClick={() => void save(draft)} disabled={busy || !draft.trim() || draftIsStale}>{busy ? "Saving" : "Save changes"}</Button> : null}
        {kind === "locked_in" && view.isPinned ? <span className="text-xs text-warning">Pinned and protected from silent overwrite</span> : null}
        {!editing ? <span className="text-xs text-muted-foreground">Select text to highlight or add a note.</span> : null}
      </div>
      {restored && editing ? (
        <div role="status" className="print-hide flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <ArrowCounterClockwise weight="bold" className="size-3.5 text-primary" aria-hidden />
          <p className="min-w-0 flex-1 text-xs text-foreground">
            Restored your unsaved edit.
            {draftIsStale ? <span className="text-muted-foreground"> This document changed since this edit. Copy what you need, then Discard.</span> : null}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => { forgetDraft(); setError(null); setDraft(view.content); setDraftRevision(view.revision); setEditing(false); }}
          >
            Discard
          </Button>
        </div>
      ) : null}
      {editing ? (
        <StudyEditor value={draft} onChange={setDraft} ariaLabel={`Edit ${kind === "summary" ? "Summary" : "Locked In"} Markdown`} />
      ) : (
        <div className="relative">
          <article
            ref={articleRef}
            tabIndex={-1}
            onPointerDown={(event) => {
              // Touch selection uses native handles and the settle timer instead.
              if (event.pointerType === "touch") return;
              pointerSelectingRef.current = true;
              window.clearTimeout(selectionSettleTimer.current);
              selectionSettleTimer.current = undefined;
            }}
            onKeyUp={captureSelectionNow}
            onTouchEnd={captureSelectionNow}
            className="print-document reading-surface rounded-xl px-5 py-6 shadow-[0_8px_30px_oklch(0_0_0/20%)] sm:px-8 sm:py-8"
          >
            <UnsourcedActionsProvider value={unsourcedActions}>
              <MarkdownBody source={view.content} annotations={activeAnnotations} />
            </UnsourcedActionsProvider>
          </article>
          {selection ? (
            <>
              <button
                type="button"
                className="annotation-menu-backdrop"
                aria-hidden="true"
                tabIndex={-1}
                onClick={closeSelectionMenu}
              />
              <div
                className={`annotation-menu-anchor absolute z-10 ${selectionAnchor ? "" : "right-2 top-2"}`}
                style={selectionAnchor ? { top: `${selectionAnchor.top}px`, left: `${selectionAnchor.left}px` } : undefined}
              >
                <AnnotationMenu quote={selection.quote} onSave={saveAnnotation} onCancel={closeSelectionMenu} />
              </div>
            </>
          ) : null}
        </div>
      )}
      {earlierAnnotations.length && !editing ? (
        <p className="sr-only" role="status">Earlier version history contains {earlierAnnotations.length} saved annotation{earlierAnnotations.length === 1 ? "" : "s"}.</p>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
