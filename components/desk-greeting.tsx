"use client";

import { useEffect, useState } from "react";

import { BirthdayCake } from "@/components/kirby-art";
import { cueKirby, KirbyCompanion } from "@/components/kirby-companion";
import type { DeskKirbyLook } from "@/lib/desk-kirby";

const WELCOMED_KEY = "omni-kirby-welcomed";
const WELCOME_SAY = "Poyo! Welcome back";
const BELATED_SAY = "Happy belated birthday!";
const WELCOME_DELAY_MS = 300;
const WELCOME_SAY_MS = 2600;
const BELATED_SAY_MS = 3400;

function welcomedThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(WELCOMED_KEY) !== null;
  } catch {
    // Blocked storage: skip the wave rather than repeat it on every visit.
    return true;
  }
}

function markWelcomed() {
  try {
    window.sessionStorage.setItem(WELCOMED_KEY, "1");
  } catch {
    // Nothing to remember in blocked storage.
  }
}

/**
 * The desk title block. Day and Night show the plain title and subtitle; Dream Land wraps
 * them in a speech bubble (app/globals.css `.desk-greeting-bubble`) with Kirby beside it.
 * The mood switch is CSS only, so the server and client render the same markup. `look` is
 * computed on the server (`deskKirbyLook`); the welcome wave (or the belated birthday dance)
 * plays once per browser session.
 */
export function DeskGreeting({
  title,
  subtitle,
  look,
}: {
  title: string;
  subtitle?: string;
  look?: DeskKirbyLook;
}) {
  const [say, setSay] = useState<string | null>(null);
  const belated = look?.belated ?? false;

  // Once per browser session: a welcome wave, or in a belated birthday first run, a dance.
  useEffect(() => {
    if (welcomedThisSession()) return;
    const start = window.setTimeout(() => {
      markWelcomed();
      setSay(belated ? BELATED_SAY : WELCOME_SAY);
      cueKirby("desk", belated ? "dance" : "wave");
    }, WELCOME_DELAY_MS);
    return () => window.clearTimeout(start);
  }, [belated]);

  useEffect(() => {
    if (!say) return;
    const clear = window.setTimeout(() => setSay(null), say === BELATED_SAY ? BELATED_SAY_MS : WELCOME_SAY_MS);
    return () => window.clearTimeout(clear);
  }, [say]);

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
      <div className="relative shrink-0">
        <KirbyCompanion
          size="lg"
          area="desk"
          // Phones: the bubble wraps over Kirby's own column so it never covers the title.
          className="kirby-say-wrap"
          pose={look?.pose ?? "idle"}
          accessory={look?.accessory ?? null}
          say={say}
        />
        {look?.cake ? (
          <div className="print-hide pointer-events-none absolute -right-1 bottom-0 hidden w-8 dreamland:block sm:w-11">
            <BirthdayCake />
          </div>
        ) : null}
      </div>
    </div>
  );
}
