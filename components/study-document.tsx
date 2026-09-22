"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { AnnotationMenu } from "@/components/annotation-menu";
import { StudyEditor } from "@/components/study-editor";
import { MarkdownBody } from "@/components/study-markdown";
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

type StudyDocumentProps = {
  userId?: string;
  reviewerId: string;
  kind: "locked_in" | "summary";
  view: SerializedView;
  onSaved: (patch: StudyViewSavePatch) => void;
  onDirtyChange?: (dirty: boolean) => void;
  controllerRef?: MutableRefObject<LockedInDraftController | null>;
};

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
  const closeSelectionMenu = useCallback(() => {
    setSelection(null);
    setSelectionAnchor(null);
    window.requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
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
      setEditing(false);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not save ${kind === "summary" ? "Summary" : "Locked In"}.`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [annotations, draftIsStale, earlierCursor, kind, onSaved, reviewerId, view.revision]);

  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      save: () => save(draft),
      discard: () => {
        setDraft(view.content);
        setDraftRevision(view.revision);
        setEditing(false);
        setError(null);
        setAnnotations(view.annotations ?? []);
        setEarlierCursor(view.annotationsNextCursor ?? null);
      },
    };
    return () => { controllerRef.current = null; };
  }, [controllerRef, draft, save, view.annotations, view.annotationsNextCursor, view.content, view.revision]);

  const captureSelection = useCallback(() => {
    if (editing || !articleRef.current) {
      closeSelectionMenu();
      return;
    }
    const currentSelection = window.getSelection();
    if (!currentSelection || currentSelection.rangeCount === 0 || currentSelection.isCollapsed) {
      if (document.activeElement?.closest(".annotation-menu")) return;
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

  useEffect(() => {
    if (editing) return;
    let frame: number | undefined;
    const onSelectionChange = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        captureSelection();
      });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [captureSelection, editing]);

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
      {!editing ? (
        <StudySidePanel
          markdown={view.content}
          annotations={annotations}
          earlierCursor={earlierCursor}
          earlierBusy={earlierBusy}
          onLoadEarlier={() => void loadEarlier()}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => { setError(null); setDraft(view.content); setDraftRevision(view.revision); setSelection(null); setSelectionAnchor(null); setEditing((current) => !current); }} disabled={busy}>
          {editing ? "Cancel edit" : `Edit ${kind === "summary" ? "Summary" : "Locked In"}`}
        </Button>
        {kind === "locked_in" && !editing ? <Button type="button" variant="outline" size="sm" onClick={() => void togglePinned()} disabled={busy}>{view.isPinned ? "Unpin" : "Pin"}</Button> : null}
        {editing ? <Button type="button" size="sm" onClick={() => void save(draft)} disabled={busy || !draft.trim() || draftIsStale}>{busy ? "Saving" : "Save changes"}</Button> : null}
        {kind === "locked_in" && view.isPinned ? <span className="text-xs text-warning">Pinned and protected from silent overwrite</span> : null}
        {!editing ? <span className="text-xs text-muted-foreground">Select text to highlight or add a note.</span> : null}
      </div>
      {editing ? (
        <StudyEditor value={draft} onChange={setDraft} ariaLabel={`Edit ${kind === "summary" ? "Summary" : "Locked In"} Markdown`} />
      ) : (
        <div className="relative">
          <article
            ref={articleRef}
            tabIndex={-1}
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
            onTouchEnd={captureSelection}
            className="reading-surface rounded-xl px-5 py-6 shadow-[0_8px_30px_oklch(0_0_0/20%)] sm:px-8 sm:py-8"
          >
            <MarkdownBody source={view.content} annotations={activeAnnotations} />
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
