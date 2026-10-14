"use client";

import { KirbyCompanion } from "@/components/kirby-companion";

/**
 * The desk title block. Day and Night show the plain title and subtitle; Dream Land wraps
 * them in a speech bubble (app/globals.css `.desk-greeting-bubble`) with Kirby beside it.
 * The mood switch is CSS only, so the server and client render the same markup.
 */
export function DeskGreeting({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6 flex items-center gap-3.5">
      <div className="desk-greeting-bubble min-w-0 flex-1 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[1.75rem]">
          {title}
          <span className="hidden dreamland:inline">!</span>
        </h1>
        {subtitle ? (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      <KirbyCompanion size="lg" className="shrink-0" />
    </div>
  );
}
