"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CheckCircle } from "@phosphor-icons/react";

/** How long the success line stays before it clears itself. */
export const PACK_READY_MS = 6000;

/**
 * A short success line shown above the study after a generation finishes, in
 * place of the full generation section. Calls `onDone` once after 6 s. `kirby` sits beside
 * the line (Dream Land) without touching the timer.
 */
export function PackReadyNotice({
  label = "Pack ready",
  onDone,
  kirby,
}: {
  label?: string;
  onDone: () => void;
  kirby?: ReactNode;
}) {
  // The latest handler, so a re-render never restarts the timer.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => onDoneRef.current(), PACK_READY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const line = (
    <p
      role="status"
      data-focus-hide
      className="print-hide inline-flex items-center gap-2 self-start rounded-lg border border-primary/30 bg-primary/8 px-3 py-2 text-sm"
    >
      <CheckCircle aria-hidden weight="fill" className="size-4 text-primary" />
      {label}
    </p>
  );
  if (!kirby) return line;
  return (
    <div data-focus-hide className="print-hide flex items-end gap-2 self-start">
      {line}
      {kirby}
    </div>
  );
}
