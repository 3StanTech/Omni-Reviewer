"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ListBullets, NotePencil } from "@phosphor-icons/react";

import { useOptionalAsk } from "@/components/ask-provider";
import { MasteryBar } from "@/components/mastery-bar";
import { SourceViewerProvider } from "@/components/source-modal";
import { MarkdownBody } from "@/components/study-markdown";
import { UnsourcedActionsProvider } from "@/components/unsourced-tag";
import { buttonVariants } from "@/components/ui/button";
import type { AnnotationRecord } from "@/lib/annotations";
import type { SectionMastery } from "@/lib/mastery";
import { outlineHeadingHref, studyOutline, type StudyHeading } from "@/lib/study-outline";
import { cn } from "@/lib/utils";

const SectionMasteryContext = createContext<SectionMastery[] | null>(null);

/** Supplies the pack's section mastery (loaded on the server) to Contents. */
export function SectionMasteryProvider({ sections, children }: { sections: SectionMastery[] | null; children: ReactNode }) {
  return <SectionMasteryContext.Provider value={sections}>{children}</SectionMasteryContext.Provider>;
}

/** The pack's section mastery, or null outside the pack page. */
export function useSectionMastery(): SectionMastery[] | null {
  return useContext(SectionMasteryContext);
}

/**
 * Answers saved from Ask, shown under Notes. Loads on first view; renders
 * nothing outside a pack or when there are none.
 */
function FromAsk() {
  const ask = useOptionalAsk();
  const ensureLoaded = ask?.ensureLoaded;
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  useEffect(() => {
    ensureLoaded?.();
  }, [ensureLoaded]);
  if (!ask) return null;
  const { saved, savedStatus } = ask;
  if (savedStatus === "ready" && saved.length === 0) return null;

  async function remove(messageId: string) {
    setRemovingId(messageId);
    setError(null);
    try {
      await ask?.removeSaved(messageId);
    } catch {
      setError("Notes did not update. Try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <section className="mt-4 border-t border-border/60 pt-3" aria-label="From Ask">
      <h4 className="text-xs font-semibold text-muted-foreground">From Ask</h4>
      {savedStatus === "loading" && saved.length === 0 ? (
        <p role="status" className="mt-2 text-muted-foreground">Loading saved answers</p>
      ) : null}
      {savedStatus === "error" && saved.length === 0 ? (
        <p role="alert" className="mt-2 text-destructive">Saved answers did not load. Close Notes and open it again.</p>
      ) : null}
      <ul className="mt-2 space-y-4">
        {saved.map(({ answer, question }) => (
          <li key={answer.id} className="space-y-1.5">
            {question ? <p className="font-medium text-foreground">{question.content}</p> : null}
            <UnsourcedActionsProvider value={null}>
              <SourceViewerProvider reviewerId={ask.reviewerId} citationSources={answer.citationSources}>
                <MarkdownBody source={answer.content} />
              </SourceViewerProvider>
            </UnsourcedActionsProvider>
            <button
              type="button"
              className="min-h-11 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50"
              disabled={removingId === answer.id}
              onClick={() => void remove(answer.id)}
            >
              Remove from Notes
            </button>
          </li>
        ))}
      </ul>
      {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
    </section>
  );
}

/**
 * The Contents list: a mastery bar beside each section heading, or a muted note when it has no score yet.
 * `currentId` marks the section being read (the rail tracks it while scrolling).
 */
export function ContentsList({ headings, sections, onNavigate, currentId }: { headings: StudyHeading[]; sections: SectionMastery[] | null; onNavigate?: () => void; currentId?: string | null }) {
  const byId = new Map((sections ?? []).map((section) => [section.id, section]));
  return (
    <ol className="space-y-1">
      {headings.length ? headings.map((heading) => {
        const section = byId.get(heading.id);
        const current = currentId === heading.id;
        return (
          <li key={heading.id} className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5", current && "-ml-2.5 border-l-2 border-primary")} style={{ paddingLeft: `${Math.max(0, heading.level - 1) * 0.75 + (current ? 0.5 : 0)}rem` }}>
            <a className={cn("min-w-0 break-words text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40", current && "font-semibold")} href={outlineHeadingHref(heading.id)} aria-current={current ? "location" : undefined} onClick={onNavigate}>{heading.text}</a>
            {section ? (section.score === null ? <span className="text-xs text-muted-foreground">Not enough answers yet</span> : <MasteryBar score={section.score} label />) : null}
          </li>
        );
      }) : <li className="text-muted-foreground">No headings yet.</li>}
    </ol>
  );
}

/** The Notes body: active highlights and notes (or a hint when there are none), then saved Ask answers. */
export function NotesList({ annotations }: { annotations: AnnotationRecord[] }) {
  const active = annotations.filter((annotation) => !annotation.archivedAt);
  return (
    <>
      <ul className="mt-3 space-y-2">{active.length ? active.map((annotation) => <li key={annotation.id}><span className={`user-annotation-${annotation.color} rounded px-1`}>{annotation.quote}</span>{annotation.note ? <span className="text-muted-foreground"> · {annotation.note}</span> : null}</li>) : <li className="text-muted-foreground">No highlights or notes yet. Select text in the document to highlight or add a note.</li>}</ul>
      <FromAsk />
    </>
  );
}

export type PanelKind = "contents" | "notes" | "earlier";

/** Opens a panel from outside the strip (Earlier version lives in More); a new nonce reopens it. */
export type PanelOpenRequest = { kind: PanelKind; nonce: number };

type StudySidePanelProps = {
  markdown: string;
  annotations: AnnotationRecord[];
  earlierCursor?: string | null;
  earlierBusy?: boolean;
  onLoadEarlier?: () => void;
  openRequest?: PanelOpenRequest | null;
  /** Classes for the Contents and Notes trigger group (the rail hides it where it shows the same tools). */
  className?: string;
};

const TRIGGER_CLASS = cn(buttonVariants({ variant: "ghost", size: "sm" }), "min-h-11 max-sm:w-11 max-sm:px-0");

export function StudySidePanel({ markdown, annotations, earlierCursor, earlierBusy = false, onLoadEarlier, openRequest = null, className }: StudySidePanelProps) {
  const [open, setOpen] = useState<PanelKind | null>(null);
  // A request made before this panel mounted (e.g. before an edit) does not reopen it.
  const [seenRequest, setSeenRequest] = useState<number | null>(() => openRequest?.nonce ?? null);
  if (openRequest && openRequest.nonce !== seenRequest) {
    setSeenRequest(openRequest.nonce);
    setOpen(openRequest.kind);
  }
  const headings = useMemo(() => studyOutline(markdown), [markdown]);
  const sectionMastery = useContext(SectionMasteryContext);
  const savedAnswerCount = useOptionalAsk()?.savedCount ?? 0;
  const active = annotations.filter((annotation) => !annotation.archivedAt);
  const earlier = annotations.filter((annotation) => annotation.archivedAt);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const notesTriggerRef = useRef<HTMLButtonElement>(null);
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

  // The phone sheet sits inside the strip's stacking context, so the floating
  // stack and the Ask pill hide while it is open (they key off this attribute).
  const sheetOpen = Boolean(open) && compactSheet;
  useEffect(() => {
    if (!sheetOpen) return;
    const root = document.documentElement;
    root.dataset.studySheetOpen = "true";
    return () => {
      delete root.dataset.studySheetOpen;
    };
  }, [sheetOpen]);

  useEffect(() => {
    if (open) {
      // Opened from More: closing returns focus to the nearest strip control.
      if (!triggerRef.current) triggerRef.current = notesTriggerRef.current;
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
      // A source viewer opened from a saved answer owns Escape and Tab while it is open.
      const panel = panelRef.current;
      const otherDialogOpen = [...document.querySelectorAll("[role='dialog']:not([hidden])")].some(
        (dialog) => dialog !== panel && !panel?.contains(dialog),
      );
      if (otherDialogOpen) return;
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

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target)) return;
      // A source viewer or menu opened from the panel is not an outside click.
      if (target instanceof Element && target.closest("[role='dialog'], [role='menu']")) return;
      // Leave focus where the reader clicked.
      triggerRef.current = null;
      setOpen(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
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
    <div ref={rootRef} className="study-side-panel relative flex items-center gap-1" aria-label="Study navigation">
      <div className={cn("flex items-center gap-1", className)}>
      <button type="button" className={TRIGGER_CLASS} aria-expanded={open === "contents"} aria-controls={`${panelHeadingId}-panel`} onClick={(event) => toggle("contents", event)}>
        <ListBullets weight="bold" aria-hidden />
        <span className="max-sm:sr-only">Contents</span>
      </button>
      <button ref={notesTriggerRef} type="button" className={TRIGGER_CLASS} aria-expanded={open === "notes"} aria-controls={`${panelHeadingId}-panel`} onClick={(event) => toggle("notes", event)}>
        <NotePencil weight="bold" aria-hidden />
        <span className="max-sm:sr-only">Notes ({active.length + savedAnswerCount})</span>
      </button>
      </div>
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
          className="study-side-panel-drawer rounded-lg border border-border/70 bg-popover p-3 text-sm text-popover-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          role="dialog"
          aria-modal={compactSheet}
          aria-labelledby={panelHeadingId}
          tabIndex={-1}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 id={panelHeadingId} className="font-semibold">{open === "contents" ? "Contents" : open === "notes" ? "Notes" : "Earlier version"}</h3>
            <button type="button" className="min-h-11 min-w-11 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" onClick={() => setOpen(null)}>Close</button>
          </div>
          {open === "contents" ? <nav className="mt-3" aria-label="Document contents"><ContentsList headings={headings} sections={sectionMastery} onNavigate={() => setOpen(null)} /></nav> : null}
          {open === "notes" ? <NotesList annotations={annotations} /> : null}
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
