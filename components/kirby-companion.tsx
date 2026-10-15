"use client";

import { useEffect, useRef, type CSSProperties } from "react";

import { Headband, KirbyHat, Nightcap, PartyHat, StarSpit } from "@/components/kirby-art";
import type { KirbyHatId } from "@/lib/kirby-hat";
import { cn } from "@/lib/utils";

/*
 * Kirby companion for the Dream Land mood: fan art drawn in SVG for this private app.
 * Shown only in Dream Land through CSS (`hidden dreamland:block`), so there is no flash
 * or hydration mismatch. Timed states are classes on the svg set through a ref (no
 * re-render); persistent poses and accessories are data attributes on the wrapper. The
 * rules and keyframes live in app/globals.css under `.kirby-companion`.
 */

export type KirbyOutcome = "happy" | "sad" | "dance" | "popout" | "wave";
export type KirbyReaction = { outcome: KirbyOutcome; key: number };
export type KirbyPose = "idle" | "inhale" | "full" | "puzzled" | "yawn" | "point";
export type KirbyAccessory = "nightcap" | "headband" | "party";

type KirbyState = KirbyOutcome | "press" | "spit";

/* Class per timed state; `wave` is `k-hello` so it never collides with the hover wave keyframes. */
const STATE_CLASS: Record<KirbyState, string> = {
  press: "k-press",
  happy: "k-happy",
  sad: "k-sad",
  dance: "k-dance",
  popout: "k-popout",
  wave: "k-hello",
  spit: "k-spit",
};
const STATE_MS: Record<KirbyState, number> = {
  press: 1000,
  happy: 1300,
  sad: 1500,
  dance: 1600,
  popout: 900,
  wave: 1400,
  spit: 1200,
};
const ALL_STATE_CLASSES = Object.values(STATE_CLASS);
const SLEEP_AFTER_MS = 20_000;
const TAPS_FOR_SPIT = 5;
const TAP_WINDOW_MS = 1500;

const SIZE_CLASS = {
  xs: "w-10",
  sm: "w-16",
  md: "w-28",
  lg: "w-[124px] max-sm:w-[84px]",
} as const;

const STAR_PATH =
  "M0.00,-7.00 L1.76,-2.43 L6.66,-2.16 L2.85,0.93 L4.11,5.66 L0.00,3.00 L-4.11,5.66 L-2.85,0.93 L-6.66,-2.16 L-1.76,-2.43 Z";

const BURST: { bx: string; by: string }[] = [
  { bx: "-58px", by: "-30px" },
  { bx: "58px", by: "-34px" },
  { bx: "-44px", by: "-62px" },
  { bx: "46px", by: "-64px" },
  { bx: "0px", by: "-78px" },
];

const LABEL_FONT: CSSProperties = { fontFamily: "var(--font-ui), sans-serif" };

type Timer = { current: ReturnType<typeof setTimeout> | undefined };

/* One passive pointermove listener and one idle timer serve every mounted Kirby. */
const instances = new Set<SVGSVGElement>();
/* Kirbys mid-reaction; the idle sleep waits until their reaction ends. */
const reacting = new Set<SVGSVGElement>();
/* Kirbys registered under an area name, so `cueKirby` can reach one from anywhere. */
const areas = new Map<string, { kirby: SVGSVGElement; timer: Timer }>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let lastActivity = 0;
let reducedMotion: MediaQueryList | undefined;

/* Busy poses (inhaling a generation, puzzled at an error) stay awake. */
const AWAKE_POSES = new Set(["inhale", "puzzled"]);

function sleepAll() {
  for (const kirby of instances) {
    if (reacting.has(kirby) || AWAKE_POSES.has(kirby.parentElement?.dataset.pose ?? "")) continue;
    kirby.classList.add("k-sleep");
  }
}

function wake() {
  for (const kirby of instances) kirby.classList.remove("k-sleep");
  lastActivity = Date.now();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(sleepAll, SLEEP_AFTER_MS);
}

function followPointer(event: PointerEvent) {
  wake();
  if (reducedMotion?.matches) return;
  for (const kirby of instances) {
    const rect = kirby.getBoundingClientRect();
    if (!rect.width) continue;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height * 0.45);
    const distance = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, distance / 300);
    kirby
      .querySelector(".k-look")
      ?.setAttribute(
        "transform",
        `translate(${((dx / distance) * 3.2 * reach).toFixed(2)} ${((dy / distance) * 2.6 * reach).toFixed(2)})`,
      );
    kirby
      .querySelector(".k-lean")
      ?.setAttribute("transform", `rotate(${((dx / distance) * 4 * reach).toFixed(2)} 60 112)`);
  }
}

/* Reduced motion keeps Kirby still: drop any pointer-driven look and lean. */
function onMotionPreference() {
  if (!reducedMotion?.matches) return;
  for (const kirby of instances) {
    kirby.querySelector(".k-look")?.removeAttribute("transform");
    kirby.querySelector(".k-lean")?.removeAttribute("transform");
  }
}

function register(kirby: SVGSVGElement) {
  instances.add(kirby);
  if (instances.size === 1) {
    window.addEventListener("pointermove", followPointer, { passive: true });
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", onMotionPreference);
  }
  wake();
}

function unregister(kirby: SVGSVGElement) {
  instances.delete(kirby);
  reacting.delete(kirby);
  if (instances.size === 0) {
    window.removeEventListener("pointermove", followPointer);
    reducedMotion?.removeEventListener("change", onMotionPreference);
    reducedMotion = undefined;
    clearTimeout(idleTimer);
  }
}

/**
 * Plays one timed state; the reflow restarts it when the same state plays twice in a row.
 * Sleep is held off while it plays, then resumes if the idle interval has already passed
 * (otherwise the pending idle timer still covers it).
 */
function play(kirby: SVGSVGElement, timer: Timer, state: KirbyState) {
  kirby.classList.remove(...ALL_STATE_CLASSES, "k-sleep");
  void kirby.getBoundingClientRect();
  kirby.classList.add(STATE_CLASS[state]);
  reacting.add(kirby);
  clearTimeout(timer.current);
  timer.current = setTimeout(() => {
    kirby.classList.remove(STATE_CLASS[state]);
    reacting.delete(kirby);
    if (
      instances.has(kirby) &&
      Date.now() - lastActivity >= SLEEP_AFTER_MS &&
      !AWAKE_POSES.has(kirby.parentElement?.dataset.pose ?? "")
    ) {
      kirby.classList.add("k-sleep");
    }
  }, STATE_MS[state]);
}

/**
 * Plays a reaction on the Kirby registered under `area` (for triggers that live outside his
 * component tree, such as the desk cheer). Does nothing when no Kirby holds that area.
 */
export function cueKirby(area: string, outcome: KirbyOutcome | "spit") {
  const entry = areas.get(area);
  if (entry) play(entry.kirby, entry.timer, outcome);
}

/** Kirby's gradients, rendered once in the root layout (never inside a hidden subtree). */
export function KirbyDefs() {
  return (
    <svg
      width={0}
      height={0}
      aria-hidden="true"
      focusable="false"
      style={{ position: "absolute" }}
    >
      <defs>
        <radialGradient id="kBody" cx="38%" cy="30%" r="72%">
          <stop offset="0" stopColor="#ffe3ee" />
          <stop offset=".45" stopColor="#ffb8d0" />
          <stop offset="1" stopColor="#f28cb1" />
        </radialGradient>
        <linearGradient id="kFoot" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f43a73" />
          <stop offset="1" stopColor="#c0144e" />
        </linearGradient>
        <linearGradient id="kEye" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#140f24" />
          <stop offset=".55" stopColor="#1a1640" />
          <stop offset="1" stopColor="#3f74ea" />
        </linearGradient>
        <linearGradient id="kFire" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#e8381f" />
          <stop offset=".55" stopColor="#ff8a1f" />
          <stop offset="1" stopColor="#ffd84a" />
        </linearGradient>
        <radialGradient id="kTomato" cx="38%" cy="35%" r="70%">
          <stop offset="0" stopColor="#ff8a7a" />
          <stop offset=".5" stopColor="#f0383a" />
          <stop offset="1" stopColor="#b8141f" />
        </radialGradient>
      </defs>
    </svg>
  );
}

/**
 * Props: `pose` persists while set; `hat` is the pack's copy hat and `accessory` wins over
 * it; `say` is a small bubble above him (flavour only, its meaning is never Kirby-only);
 * `area` lets `cueKirby` reach him. Asleep he wears the nightcap; five quick taps spit a star.
 */
export function KirbyCompanion({
  size = "md",
  reaction,
  pose = "idle",
  hat,
  accessory,
  say,
  area,
  className,
}: {
  size?: keyof typeof SIZE_CLASS;
  reaction?: KirbyReaction | null;
  pose?: KirbyPose;
  hat?: KirbyHatId | null;
  accessory?: KirbyAccessory | null;
  say?: string | null;
  area?: string;
  className?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const taps = useRef<number[]>([]);

  useEffect(() => {
    const kirby = svgRef.current;
    const timer = stateTimer;
    if (!kirby) return;
    register(kirby);
    return () => {
      unregister(kirby);
      clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    const kirby = svgRef.current;
    if (!area || !kirby) return;
    const entry = { kirby, timer: stateTimer };
    areas.set(area, entry);
    return () => {
      if (areas.get(area) === entry) areas.delete(area);
    };
  }, [area]);

  const reactionKey = reaction?.key;
  const reactionOutcome = reaction?.outcome;
  useEffect(() => {
    if (reactionKey === undefined || !reactionOutcome || !svgRef.current) return;
    play(svgRef.current, stateTimer, reactionOutcome);
  }, [reactionKey, reactionOutcome]);

  function onTap(kirby: SVGSVGElement) {
    const now = Date.now();
    taps.current = [...taps.current.filter((at) => now - at < TAP_WINDOW_MS), now];
    if (taps.current.length >= TAPS_FOR_SPIT) {
      taps.current = [];
      play(kirby, stateTimer, "spit");
    } else {
      play(kirby, stateTimer, "press");
    }
  }

  const headPiece = accessory ? accessory : hat ? "hat" : null;

  return (
    <div
      className={cn("kirby-companion relative hidden dreamland:block print:hidden", SIZE_CLASS[size], className)}
      data-pose={pose}
      data-accessory={accessory ?? undefined}
    >
      {say ? (
        <span className="kirby-say" aria-hidden="true">
          {say}
        </span>
      ) : null}
      <svg
        ref={svgRef}
        className="kirby"
        viewBox="-12 -26 144 152"
        role="img"
        aria-label="Kirby"
        onPointerEnter={() => svgRef.current?.classList.add("k-hover")}
        onPointerLeave={() => svgRef.current?.classList.remove("k-hover")}
        onClick={(event) => onTap(event.currentTarget)}
      >
        <ellipse cx="60" cy="118" rx="34" ry="4.5" fill="#000" opacity=".08" />
        <g className="k-wind" aria-hidden="true" fill="none" stroke="#9fc8ee" strokeWidth="2.4" strokeLinecap="round">
          <path d="M74 70 Q100 58 128 52" />
          <path d="M74 76 Q102 76 130 76" />
          <path d="M74 82 Q100 94 128 100" />
        </g>
        <g className="k-jump tc">
          <g className="k-pose tb">
            <g className="k-lean">
              <ellipse className="k-outline" cx="40" cy="106" rx="19" ry="10.5" transform="rotate(-14 40 106)" fill="url(#kFoot)" />
              <ellipse className="k-outline" cx="80" cy="106" rx="19" ry="10.5" transform="rotate(14 80 106)" fill="url(#kFoot)" />
              <g className="k-bob tb">
                <g className="arm-l" style={{ transformBox: "view-box", transformOrigin: "28px 72px" }}>
                  <ellipse className="k-outline" cx="18" cy="73" rx="13" ry="10.5" transform="rotate(-25 18 73)" fill="#ffb3cc" />
                </g>
                <g className="arm-r" style={{ transformBox: "view-box", transformOrigin: "92px 68px" }}>
                  <ellipse className="k-outline" cx="102" cy="66" rx="13" ry="10.5" transform="rotate(30 102 66)" fill="#ffb3cc" />
                </g>
                <circle className="k-body k-outline" cx="60" cy="64" r="42" fill="url(#kBody)" />
                <g className="k-look">
                  <g className="eyes-open tc">
                    <ellipse cx="50" cy="54" rx="5.6" ry="12.5" fill="url(#kEye)" />
                    <ellipse cx="70" cy="54" rx="5.6" ry="12.5" fill="url(#kEye)" />
                    <ellipse cx="50" cy="47.2" rx="3.3" ry="5" fill="#fff" />
                    <ellipse cx="70" cy="47.2" rx="3.3" ry="5" fill="#fff" />
                  </g>
                  <g className="eyes-happy" fill="none" stroke="#1a1640" strokeWidth="3.2" strokeLinecap="round">
                    <path d="M44 57 q6 -10 12 0" />
                    <path d="M64 57 q6 -10 12 0" />
                  </g>
                  <g className="eyes-sad" fill="none" stroke="#1a1640" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M45 48 l9 6 l-9 6" />
                    <path d="M75 48 l-9 6 l9 6" />
                  </g>
                  <g className="eyes-sleep" fill="none" stroke="#1a1640" strokeWidth="3.2" strokeLinecap="round">
                    <path d="M44 56 q6 4 12 0" />
                    <path d="M64 56 q6 4 12 0" />
                  </g>
                  <g className="blush" opacity=".6">
                    <ellipse cx="36.5" cy="69" rx="7.5" ry="4" fill="#ff5c93" />
                    <ellipse cx="83.5" cy="69" rx="7.5" ry="4" fill="#ff5c93" />
                  </g>
                  <g className="k-cheeks" fill="#ffc6da" stroke="#e2799f" strokeWidth="1">
                    <ellipse cx="38" cy="72" rx="9" ry="7" />
                    <ellipse cx="82" cy="72" rx="9" ry="7" />
                  </g>
                  <path className="mouth-closed" d="M55.5 71 Q60 77.5 64.5 71 Z" fill="#b5134a" />
                  <g className="mouth-open">
                    <ellipse cx="60" cy="75" rx="6.5" ry="7.2" fill="#9e0f40" />
                    <ellipse cx="60" cy="79.2" rx="4" ry="2.6" fill="#ff7aa5" />
                  </g>
                  <path className="mouth-sad" d="M53 76 q3.5 -3 7 0 q3.5 3 7 0" fill="none" stroke="#9e0f40" strokeWidth="2.4" strokeLinecap="round" />
                  <g className="mouth-inhale">
                    <ellipse cx="60" cy="77" rx="12.5" ry="14" fill="#7d0a33" />
                    <ellipse cx="60" cy="84.5" rx="7.5" ry="4" fill="#ff7aa5" />
                  </g>
                  <ellipse className="mouth-o" cx="60" cy="75" rx="3.4" ry="4" fill="#9e0f40" />
                  <path className="mouth-full" d="M54 73 Q60 78 66 73" fill="none" stroke="#9e0f40" strokeWidth="2.4" strokeLinecap="round" />
                  <g className="mouth-yawn">
                    <ellipse cx="60" cy="76" rx="8" ry="10" fill="#9e0f40" />
                    <ellipse cx="60" cy="81.5" rx="5" ry="3" fill="#ff7aa5" />
                  </g>
                </g>
                {headPiece === "hat" && hat ? (
                  <g className="k-hat">
                    <KirbyHat id={hat} />
                  </g>
                ) : null}
                {accessory ? (
                  <g className={cn("k-acc", accessory === "nightcap" && "k-acc-nightcap")}>
                    {accessory === "nightcap" ? <Nightcap /> : accessory === "headband" ? <Headband /> : <PartyHat />}
                  </g>
                ) : null}
                {accessory !== "nightcap" ? (
                  <g className="k-sleepcap" aria-hidden="true">
                    <Nightcap />
                  </g>
                ) : null}
              </g>
            </g>
          </g>
        </g>
        <StarSpit />
        <g className="k-burst" aria-hidden="true" fill="#f6c736" stroke="#d39a0c" strokeWidth=".8" strokeLinejoin="round">
          {BURST.map((star) => (
            <g key={`${star.bx} ${star.by}`} transform="translate(60 50)">
              <path
                className="tc"
                style={{ "--bx": star.bx, "--by": star.by } as CSSProperties}
                d={STAR_PATH}
              />
            </g>
          ))}
        </g>
        <path className="k-sweat" aria-hidden="true" d="M100 26 q6 9 0 12.5 q-6 -3.5 0 -12.5z" fill="#9fdcff" stroke="#4aa8e8" strokeWidth="1" />
        <text className="k-question" aria-hidden="true" x="96" y="20" fontSize="26" fontWeight="700" fill="#7b6fd0" stroke="#fff" strokeWidth="1" style={LABEL_FONT}>
          ?
        </text>
        <text className="k-zzz" aria-hidden="true" x="98" y="16" fontSize="15" fontWeight="700" fill="#7b8fc9" style={LABEL_FONT}>
          z
        </text>
        <g className="k-poyo" aria-hidden="true">
          <rect x="70" y="-22" width="50" height="21" rx="10.5" fill="#fff" stroke="#e2799f" strokeWidth="1.3" />
          <text x="95" y="-7.5" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="#c2185b" style={LABEL_FONT}>
            poyo!
          </text>
        </g>
      </svg>
    </div>
  );
}
