"use client";

import { useState, type ReactNode } from "react";

import {
  BirthdayCake,
  CAFE_TREATS,
  CafeTreat,
  GreenGreensHills,
  MaximTomato,
  WaddleDee,
  WarpStar,
  type CafeTreatState,
} from "@/components/kirby-art";
import {
  cueKirby,
  KirbyCompanion,
  type KirbyAccessory,
  type KirbyOutcome,
  type KirbyPose,
  type KirbyReaction,
} from "@/components/kirby-companion";
import { Button } from "@/components/ui/button";
import { KIRBY_HATS } from "@/lib/kirby-hat";

const POSES: KirbyPose[] = ["idle", "inhale", "full", "puzzled", "yawn", "point"];
const ACCESSORIES: KirbyAccessory[] = ["nightcap", "headband", "party"];
const OUTCOMES: KirbyOutcome[] = ["happy", "sad", "dance", "popout", "wave"];
const TREAT_STATES: CafeTreatState[] = ["full", "outline", "plate", "faint"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-[20px] border border-border bg-card p-4 sm:p-5">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="flex flex-col items-center gap-2 pt-6">
      {children}
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

/** Every Kirby piece for the D17 art gate, rendered with the real components and CSS. */
export function KirbySheet() {
  const [reaction, setReaction] = useState<KirbyReaction | null>(null);
  const [say, setSay] = useState<string | null>("Poyo! Welcome back");

  return (
    <div data-look="dreamland" className="min-h-full bg-background px-4 py-6 text-foreground sm:px-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Kirby art sheet</h1>
          <p className="text-sm text-muted-foreground">
            Dev only. Everything here shows in Dream Land only, is hidden in print, and holds still under reduced motion.
          </p>
        </header>

        <Section title="Reactions" note="Replay each one. Tap a Kirby five times quickly to spit a star.">
          <div className="flex flex-wrap items-end gap-6">
            <Tile label="reaction target">
              <KirbyCompanion size="md" reaction={reaction} area="sheet" say={say} />
            </Tile>
            <div className="flex flex-wrap gap-2">
              {OUTCOMES.map((outcome) => (
                <Button key={outcome} variant="outline" size="sm" onClick={() => setReaction({ outcome, key: Date.now() })}>
                  {outcome}
                </Button>
              ))}
              <Button variant="outline" size="sm" onClick={() => cueKirby("sheet", "spit")}>
                spit (5 taps)
              </Button>
              <Button variant="outline" size="sm" onClick={() => setSay((s) => (s ? null : "Poyo! Welcome back"))}>
                {say ? "hide bubble" : "show bubble"}
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Poses" note="Persistent while set. Point aims down-left at the first-run guide.">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {POSES.map((pose) => (
              <Tile key={pose} label={pose}>
                <KirbyCompanion size="md" pose={pose} />
              </Tile>
            ))}
          </div>
        </Section>

        <Section title="Accessories" note="One at a time; an accessory wins over a copy hat. Asleep, any Kirby wears the nightcap.">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {ACCESSORIES.map((accessory) => (
              <Tile key={accessory} label={accessory}>
                <KirbyCompanion size="md" accessory={accessory} />
              </Tile>
            ))}
            <Tile label="party + cake (birthday)">
              <div className="flex items-end gap-1">
                <KirbyCompanion size="md" accessory="party" />
                <BirthdayCake className="w-12" />
              </div>
            </Tile>
          </div>
        </Section>

        <Section title="Copy hats" note="Stable per pack from its id.">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {KIRBY_HATS.map((hat) => (
              <Tile key={hat} label={hat}>
                <KirbyCompanion size="md" hat={hat} />
              </Tile>
            ))}
          </div>
        </Section>

        <Section title="Sizes and combinations">
          <div className="flex flex-wrap items-end gap-6">
            <Tile label="xs full tummy">
              <KirbyCompanion size="xs" pose="full" />
            </Tile>
            <Tile label="sm inhale">
              <KirbyCompanion size="sm" pose="inhale" />
            </Tile>
            <Tile label="sm headband">
              <KirbyCompanion size="sm" accessory="headband" say="Good luck today!" />
            </Tile>
            <Tile label="sm puzzled">
              <KirbyCompanion size="sm" pose="puzzled" />
            </Tile>
            <Tile label="lg desk">
              <KirbyCompanion size="lg" pose="yawn" />
            </Tile>
          </div>
        </Section>

        <Section title="Helpers" note="Waddle Dee stays at most about 60% of a md Kirby.">
          <div className="flex flex-wrap items-end gap-6">
            <Tile label="md Kirby (112px)">
              <KirbyCompanion size="md" />
            </Tile>
            <Tile label="Waddle Dee holding a page (64px)">
              <WaddleDee holding="page" className="w-16" />
            </Tile>
            <Tile label="Waddle Dee (Ask, 24px)">
              <WaddleDee className="w-6" />
            </Tile>
            <Tile label="Warp Star with trail">
              <WarpStar className="w-14" />
            </Tile>
            <Tile label="Warp Star">
              <WarpStar trail={false} className="w-6" />
            </Tile>
            <Tile label="Maxim Tomato">
              <MaximTomato className="w-8" />
            </Tile>
          </div>
        </Section>

        <Section title="Café treats" note="Week row in Dream Land: studied = treat, today = outline, missed = empty plate, future = faint plate.">
          <div className="overflow-x-auto">
            <table className="text-xs text-muted-foreground">
              <thead>
                <tr>
                  <th className="pr-3 text-left font-medium">state</th>
                  {DAYS.map((day, i) => (
                    <th key={day} className="px-1 font-medium">
                      {day}
                      <span className="block font-normal">{CAFE_TREATS[i]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TREAT_STATES.map((state) => (
                  <tr key={state}>
                    <td className="pr-3">{state}</td>
                    {CAFE_TREATS.map((kind) => (
                      <td key={kind} className="px-1 py-1">
                        <CafeTreat kind={kind} state={state} className="mx-auto w-10" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Green Greens" note="Decorative band at the bottom of the desk.">
          <GreenGreensHills className="h-24 w-full max-sm:h-16" />
        </Section>
      </div>
    </div>
  );
}
