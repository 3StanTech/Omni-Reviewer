"use client";

import { KirbyCompanion } from "@/components/kirby-companion";
import type { KirbyHatId } from "@/lib/kirby-hat";

/** "Ready..." then "Go!" before a timed run is created, so the countdown never costs timed seconds. */
export const READY_MS = 800;
export const GO_MS = 600;

export type ReadyGoPhase = "ready" | "go";

export function waitMs(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

/**
 * The countdown overlay over the timed start panel (the parent is `relative`). The live
 * region stays mounted so screen readers hear both words; the overlay shows only while a
 * phase is set. Kirby (Dream Land) lives only here and leaves before the timer starts.
 */
export function ReadyGo({ phase, hat }: { phase: ReadyGoPhase | null; hat: KirbyHatId }) {
  return (
    <div aria-live="assertive" aria-atomic="true" className="print-hide">
      {phase ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-3 rounded-xl bg-surface/95">
          <KirbyCompanion
            size="sm"
            hat={hat}
            reaction={phase === "go" ? { outcome: "happy", key: 1 } : null}
            className="shrink-0"
          />
          <p
            key={phase}
            className="font-heading text-3xl font-semibold text-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-200"
          >
            {phase === "ready" ? "Ready..." : "Go!"}
          </p>
        </div>
      ) : null}
    </div>
  );
}
