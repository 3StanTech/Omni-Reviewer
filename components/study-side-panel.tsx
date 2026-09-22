"use client";

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";

import type { AnnotationRecord } from "@/lib/annotations";
import { outlineHeadingHref, studyOutline } from "@/lib/study-outline";

type StudySidePanelProps = {
  markdown: string;
  annotations: AnnotationRecord[];
  earlierCursor?: string | null;
  earlierBusy?: boolean;
  onLoadEarlier?: () => void;
};

type PanelKind = "contents" | "notes" | "earlier";

export function StudySidePanel({ markdown, annotations, earlierCursor, earlierBusy = false, onLoadEarlier }: StudySidePanelProps) {
  const [open, setOpen] = useState<PanelKind | null>(null);
  const headings = useMemo(() => studyOutline(markdown), [markdown]);
  const active = annotations.filter((annotation) => !annotation.archivedAt);
  const earlier = annotations.filter((annotation) => annotation.archivedAt);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelHeadingId = useId();
  const [compactSheet, setCompactSheet] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const sync = () => setCompactSheet(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
      return;
    }
    const trigger = triggerRef.current;
    triggerRef.current = null;
    trigger?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(null);
        return;
      }
      if (event.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = [...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        )];
        if (focusable.length === 0) {
          event.preventDefault();
          panel.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!panel.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function toggle(kind: PanelKind, event: MouseEvent<HTMLButtonElement>) {
    if (open === kind) {
      setOpen(null);
      return;
    }
    triggerRef.current = event.currentTarget;
    setOpen(kind);
  }

  return (
    <div className="study-side-panel flex flex-wrap gap-2" aria-label="Study navigation">
      <button type="button" className="min-h-11 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" aria-expanded={open === "contents"} aria-controls={`${panelHeadingId}-panel`} onClick={(event) => toggle("contents", event)}>Contents</button>
      <button type="button" className="min-h-11 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" aria-expanded={open === "notes"} aria-controls={`${panelHeadingId}-panel`} onClick={(event) => toggle("notes", event)}>Notes ({active.length})</button>
      {earlier.length || earlierCursor ? <button type="button" className="min-h-11 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" aria-expanded={open === "earlier"} aria-controls={`${panelHeadingId}-panel`} onClick={(event) => toggle("earlier", event)}>Earlier version ({earlier.length})</button> : null}
      {open ? (
        <>
        <button
          type="button"
          className="study-side-panel-backdrop"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setOpen(null)}
        />
        <div
          ref={panelRef}
          id={`${panelHeadingId}-panel`}
          className="study-side-panel-drawer basis-full rounded-lg border border-border/70 bg-muted/20 p-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          role="dialog"
          aria-modal={compactSheet}
          aria-labelledby={panelHeadingId}
          tabIndex={-1}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 id={panelHeadingId} className="font-semibold">{open === "contents" ? "Contents" : open === "notes" ? "Notes" : "Earlier version"}</h3>
            <button type="button" className="min-h-11 min-w-11 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" onClick={() => setOpen(null)}>Close</button>
          </div>
          {open === "contents" ? <nav className="mt-3" aria-label="Document contents"><ol className="space-y-1">{headings.length ? headings.map((heading) => <li key={heading.id} style={{ paddingLeft: `${Math.max(0, heading.level - 1) * 0.75}rem` }}><a className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" href={outlineHeadingHref(heading.id)} onClick={() => setOpen(null)}>{heading.text}</a></li>) : <li className="text-muted-foreground">No headings yet.</li>}</ol></nav> : null}
          {open === "notes" ? <ul className="mt-3 space-y-2">{active.length ? active.map((annotation) => <li key={annotation.id}><span className={`user-annotation-${annotation.color} rounded px-1`}>{annotation.quote}</span>{annotation.note ? <span className="text-muted-foreground"> · {annotation.note}</span> : null}</li>) : <li className="text-muted-foreground">No highlights or notes yet.</li>}</ul> : null}
          {open === "earlier" ? (
            <div className="mt-3 space-y-3">
              {earlier.length ? <ul className="space-y-2 text-muted-foreground">{earlier.map((annotation) => <li key={annotation.id}>“{annotation.quote}”{annotation.note ? ` · ${annotation.note}` : ""}</li>)}</ul> : <p className="text-muted-foreground">No earlier annotations loaded yet.</p>}
              {earlierCursor ? <button type="button" className="min-h-11 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" onClick={onLoadEarlier} disabled={earlierBusy}>{earlierBusy ? "Loading earlier annotations" : "Load more earlier annotations"}</button> : null}
            </div>
          ) : null}
        </div>
        </>
      ) : null}
    </div>
  );
}
