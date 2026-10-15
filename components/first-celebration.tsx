"use client";

import { Confetti, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { celebrateIfFirst, type FirstKind } from "@/lib/firsts";

const COPY: Record<FirstKind, string> = {
  pack: "Your first pack is ready!",
  sitting: "First sitting done!",
  "all-due": "Everything due is done for today!",
};

const CLEAR_AFTER_MS = 8000;

/**
 * Asks once per mount, when `active` first turns true, whether this event is
 * the account's first of its kind. Returns whether to show the cheer.
 */
export function useFirstCelebration(kind: FirstKind, active: boolean) {
  const [show, setShow] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    if (!active || asked.current) return;
    asked.current = true;
    void celebrateIfFirst(kind).then((first) => {
      if (first) setShow(true);
    });
  }, [active, kind]);
  return { show, dismiss: () => setShow(false) };
}

/** One cheer line for a first-time moment; clears after 8 s or on dismiss. */
export function FirstCelebration({ kind, onDone }: { kind: FirstKind; onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const timer = window.setTimeout(() => onDoneRef.current(), CLEAR_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [kind]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-first={kind}
      className="print-hide flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300"
    >
      <Confetti weight="duotone" className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1">{COPY[kind]}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDoneRef.current()}
        className="-my-1 -mr-1 inline-flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        <X weight="bold" className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
