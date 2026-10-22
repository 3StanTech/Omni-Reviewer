"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { MusicNotes } from "@phosphor-icons/react";

import { ALL_STATE_CLASSES, KirbyCompanion, STATE_CLASS, STATE_MS, type KirbyState } from "@/components/kirby-companion";
import { cn } from "@/lib/utils";

/** The shipped timed states the guide plays (app/globals.css `.kirby-companion`). */
export type GuideState = Extract<KirbyState, "press" | "happy" | "dance" | "wave" | "yawn">;
const NOTE_EVERY_MS = 1500;
const NOTE_MS = 2200;

export type GuidePoint = { left: number; top: number };

export type TourKirbyHandle = {
  /** Whether he has a spot yet (the first stop starts from his home Kirby instead). */
  placed: () => boolean;
  /** Jumps to a spot without moving through the air. */
  place: (to: GuidePoint) => void;
  /** Rides the Warp Star along an arc to his next spot (a jump under reduced motion). */
  travel: (to: GuidePoint) => Promise<void>;
  play: (state: GuideState) => void;
  /** Raises his arm to point back at the lit control (the wander nudge). */
  armUp: (up: boolean) => void;
  /** Puzzled for a moment (a press on the dimmed page). */
  puzzle: (ms: number) => void;
};

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The tour's guide Kirby: the shipped `lg` companion in a fixed box the tour layer moves. Dream
 * Land only and print-hidden through the companion's own classes. Petting (a wave on hover,
 * "poyo!" on click) is the companion's own; the tour adds travel and the timed reactions.
 */
export function TourKirby({ ref, hidden, notes }: { ref: Ref<TourKirbyHandle>; hidden: boolean; notes: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const spot = useRef<GuidePoint | null>(null);
  const anim = useRef<Animation | null>(null);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // He looks up toward the lit control until the pointer first moves (then the shipped follow takes over).
  const [lookUp, setLookUp] = useState(true);
  const [arm, setArm] = useState(false);
  const [puzzled, setPuzzled] = useState(false);
  const puzzleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Music notes float up while the music plays unmuted (never under reduced motion).
  const [floating, setFloating] = useState<{ id: number; left: number }[]>([]);
  useEffect(() => {
    if (!notes || hidden) return;
    let id = 0;
    const timer = window.setInterval(() => {
      if (reducedMotion()) return;
      const note = { id: ++id, left: 55 + Math.random() * 25 };
      setFloating((current) => [...current, note]);
      window.setTimeout(() => setFloating((current) => current.filter((n) => n.id !== note.id)), NOTE_MS);
    }, NOTE_EVERY_MS);
    return () => {
      window.clearInterval(timer);
      setFloating([]);
    };
  }, [notes, hidden]);

  useEffect(() => {
    if (!lookUp) return;
    function onMove() {
      if (!reducedMotion()) setLookUp(false);
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [lookUp]);

  useEffect(
    () => () => {
      clearTimeout(stateTimer.current);
      clearTimeout(puzzleTimer.current);
    },
    [],
  );

  useImperativeHandle(ref, () => {
    const setSpot = (to: GuidePoint) => {
      spot.current = to;
      const box = boxRef.current;
      if (box) {
        box.style.left = `${to.left}px`;
        box.style.top = `${to.top}px`;
      }
    };
    return {
      placed: () => spot.current !== null,
      place: (to) => {
        anim.current?.cancel();
        anim.current = null;
        boxRef.current?.classList.remove("riding", "west");
        setSpot(to);
      },
      travel: async (to) => {
        const box = boxRef.current;
        const from = spot.current;
        anim.current?.cancel();
        anim.current = null;
        setSpot(to);
        if (!box || !from || reducedMotion()) return;
        const dx = to.left - from.left;
        const dy = to.top - from.top;
        const dist = Math.hypot(dx, dy);
        if (dist < 6) return;
        const lift = Math.min(150, 50 + dist * 0.18);
        // Already at the new spot; each frame offsets him back along the arc from the old one.
        const frames = Array.from({ length: 11 }, (_, i) => {
          const t = i / 10;
          const x = dx * (t - 1);
          const y = dy * (t - 1) - 4 * lift * t * (1 - t);
          return { transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` };
        });
        box.classList.add("riding");
        box.classList.toggle("west", dx < 0);
        const running = box.animate(frames, {
          duration: Math.max(800, Math.min(1400, 600 + dist * 0.6)),
          easing: "cubic-bezier(.45,.05,.3,1)",
        });
        anim.current = running;
        try {
          await running.finished;
        } catch {
          // Cancelled by the next move.
        }
        if (anim.current === running) {
          anim.current = null;
          box.classList.remove("riding", "west");
        }
      },
      play: (state) => {
        const kirby = boxRef.current?.querySelector<SVGSVGElement>("svg.kirby");
        if (!kirby) return;
        kirby.classList.remove(...ALL_STATE_CLASSES);
        void kirby.getBoundingClientRect();
        kirby.classList.add(STATE_CLASS[state]);
        clearTimeout(stateTimer.current);
        stateTimer.current = setTimeout(() => kirby.classList.remove(STATE_CLASS[state]), STATE_MS[state]);
      },
      armUp: (up) => setArm(up),
      puzzle: (ms) => {
        setPuzzled(true);
        clearTimeout(puzzleTimer.current);
        puzzleTimer.current = setTimeout(() => setPuzzled(false), ms);
      },
    };
  }, []);

  return (
    <div ref={boxRef} className="tour-guide pointer-events-auto fixed" hidden={hidden}>
      <KirbyCompanion
        size="lg"
        sleepAfterMs={null}
        pose={puzzled ? "puzzled" : "idle"}
        className={cn(lookUp && "look-up", arm && "arm-up")}
      />
      {floating.map((note) => (
        <span key={note.id} aria-hidden className="tour-note hidden dreamland:block" style={{ left: `${note.left}%` }}>
          <MusicNotes weight="fill" />
        </span>
      ))}
    </div>
  );
}
