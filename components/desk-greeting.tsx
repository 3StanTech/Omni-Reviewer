"use client";

import { useEffect, useState } from "react";

import { BirthdayCake, GreetingStickers } from "@/components/kirby-art";
import { cueKirby, KirbyCompanion } from "@/components/kirby-companion";
import { useTour } from "@/components/tour/tour-provider";
import {
  markWelcomed,
  WELCOME_DELAY_MS,
  WELCOME_SAY_MS,
  welcomedThisSession,
  type DeskKirbyLook,
} from "@/lib/desk-kirby";
import { cn } from "@/lib/utils";

const WELCOME_SAY = "Poyo! Welcome back";
const BELATED_SAY = "Belated Happy Birthday!";
const BELATED_SAY_MS = 3400;

/**
 * The desk title block. Day and Night show the plain title and subtitle; Dream Land wraps
 * them in a scalloped, stitched speech card with a sweets sticker row (app/globals.css
 * `.desk-greeting-bubble`) and Kirby beside it.
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
  // One Kirby on screen: the desk Kirby steps aside while the tour guide holds the desk.
  const guideHere = useTour()?.guideArea === "desk";

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
    <div className="mb-6 flex items-center gap-3.5 dreamland:mb-[34px] dreamland:items-start">
      <div className="desk-greeting-bubble min-w-0 flex-1">
        {/* Dream Land: the stitched seam inside the scalloped card. */}
        <span aria-hidden="true" className="desk-greeting-stitch hidden dreamland:block" />
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[1.75rem]">
          {title}
          <span className="hidden dreamland:inline">!</span>
        </h1>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
        ) : null}
        <GreetingStickers />
      </div>
      <div data-tour-home="desk" className={cn("relative shrink-0 dreamland:mt-3.5", guideHere && "invisible")}>
        <KirbyCompanion
          size="lg"
          area="desk"
          // Phones: the bubble wraps over Kirby's own column so it never covers the title.
          className="kirby-say-wrap"
          pose={look?.pose ?? "idle"}
          accessory={look?.accessory ?? null}
          say={say}
          // The desk Kirby never idles to sleep; late at night he yawns now and then.
          sleepAfterMs={null}
          yawnEveryMs={look?.yawnEveryMs ?? null}
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
