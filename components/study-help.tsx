"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Question } from "@phosphor-icons/react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The explainer's lines, each a run of bold leads and the text after them. */
export const STUDY_HELP_LINES: ReadonlyArray<ReadonlyArray<{ lead: string; text: string }>> = [
  [
    {
      lead: "New",
      text: ": cards you have not studied yet. Up to 20 a day per pack, or spread out until the exam when an exam date is set.",
    },
  ],
  [{ lead: "To review", text: ": cards you studied before whose return date has come." }],
  [
    { lead: "Again", text: " brings a card back tomorrow. " },
    {
      lead: "Good",
      text: " spaces it out: about 3 days, then 2 weeks, then 2 months, then longer. No card comes back after your exam date.",
    },
  ],
  [
    {
      lead: "Weak section",
      text: ": under 60% correct across 3 or more answers from Test Me and Carded. See the plan suggests a re-test or a re-read.",
    },
  ],
];

const TRIGGER_CLASS = cn(buttonVariants({ variant: "ghost", size: "sm" }), "min-h-11 max-sm:w-11 max-sm:px-0");

/**
 * "How cards come back": how New, To review, Again, Good, the exam cap and Weak work.
 * A popover under the trigger on desktop, the Contents sheet pattern on phones.
 */
export function StudyHelp({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [compactSheet, setCompactSheet] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const headingId = useId();

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
    if (restoreFocus.current) triggerRef.current?.focus();
    restoreFocus.current = false;
  }, [open]);

  // The floating jump and Ask buttons hide under the phone sheet, as they do under Contents.
  useEffect(() => {
    if (!open || !compactSheet) return;
    const root = document.documentElement;
    root.dataset.studySheetOpen = "true";
    return () => {
      delete root.dataset.studySheetOpen;
    };
  }, [open, compactSheet]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      restoreFocus.current = true;
      setOpen(false);
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target)) return;
      // Leave focus where the reader clicked.
      setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function close() {
    restoreFocus.current = true;
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={cn("print-hide relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        className={TRIGGER_CLASS}
        aria-label="How cards come back"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${headingId}-panel`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Question weight="bold" aria-hidden />
        <span className="max-sm:sr-only">How cards come back</span>
      </button>
      {open ? (
        <>
          <button
            type="button"
            className="study-side-panel-backdrop"
            aria-hidden="true"
            tabIndex={-1}
            onClick={close}
          />
          <div
            ref={panelRef}
            id={`${headingId}-panel`}
            className="study-side-panel-drawer rounded-lg border border-border/70 bg-popover p-3 text-left text-sm whitespace-normal text-popover-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            role="dialog"
            aria-modal={compactSheet}
            aria-labelledby={headingId}
            tabIndex={-1}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 id={headingId} className="font-semibold">How cards come back</h3>
              <button
                type="button"
                className="min-h-11 min-w-11 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                onClick={close}
              >
                Close
              </button>
            </div>
            <ul className="mt-3 space-y-2 text-muted-foreground">
              {STUDY_HELP_LINES.map((line) => (
                <li key={line[0].lead}>
                  {line.map((part) => (
                    <span key={part.lead}>
                      <strong className="font-semibold text-foreground">{part.lead}</strong>
                      {part.text}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
