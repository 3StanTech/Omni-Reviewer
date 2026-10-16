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

export type KirbyOutcome = "happy" | "sad" | "dance" | "ride" | "wave";
export type KirbyReaction = { outcome: KirbyOutcome; key: number };
export type KirbyPose = "idle" | "inhale" | "full" | "puzzled" | "point";
export type KirbyAccessory = "nightcap" | "headband" | "party";

type KirbyState = KirbyOutcome | "press" | "spit" | "yawn";

/* Class per timed state; `wave` is `k-hello` so it never collides with the hover wave keyframes. */
const STATE_CLASS: Record<KirbyState, string> = {
  press: "k-press",
  happy: "k-happy",
  sad: "k-sad",
  dance: "k-dance",
  ride: "k-ride",
  wave: "k-hello",
  spit: "k-spit",
  yawn: "k-yawning",
};
const STATE_MS: Record<KirbyState, number> = {
  press: 1000,
  happy: 1300,
  sad: 1500,
  dance: 1600,
  ride: 2400,
  wave: 1400,
  spit: 1200,
  yawn: 6_000,
};
const ALL_STATE_CLASSES = Object.values(STATE_CLASS);
/* Default idle time before a Kirby falls asleep; `sleepAfterMs={null}` keeps one awake. */
const SLEEP_AFTER_MS = 120_000;
/* The first recurring yawn waits for the desk's welcome wave or birthday dance to finish. */
const FIRST_YAWN_MS = 2_500;
const YAWN_RETRY_MS = 1_000;
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

/* Each Kirby's idle threshold from `data-sleep-after`; null when he never sleeps. */
function sleepAfter(kirby: SVGSVGElement): number | null {
  const value = kirby.dataset.sleepAfter;
  return value ? Number(value) : null;
}

/* Whether this Kirby has been idle past his own threshold and may sleep now. */
function readyToSleep(kirby: SVGSVGElement): boolean {
  const threshold = sleepAfter(kirby);
  return (
    threshold !== null &&
    Date.now() - lastActivity >= threshold &&
    !AWAKE_POSES.has(kirby.parentElement?.dataset.pose ?? "")
  );
}

/* Schedules the idle timer for the nearest threshold among Kirbys still awake. */
function scheduleSleep() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const idle = Date.now() - lastActivity;
  let next = Infinity;
  for (const kirby of instances) {
    const threshold = sleepAfter(kirby);
    if (threshold === null || threshold <= idle || kirby.classList.contains("k-sleep")) continue;
    next = Math.min(next, threshold - idle);
  }
  if (next !== Infinity) idleTimer = setTimeout(sleepAll, next);
}

function sleepAll() {
  for (const kirby of instances) {
    if (!reacting.has(kirby) && readyToSleep(kirby)) kirby.classList.add("k-sleep");
  }
  scheduleSleep();
}

function wake() {
  for (const kirby of instances) kirby.classList.remove("k-sleep");
  lastActivity = Date.now();
  scheduleSleep();
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
 * Sleep is held off while it plays, then resumes if this Kirby's idle threshold has already
 * passed (otherwise the pending idle timer still covers it).
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
    if (instances.has(kirby) && readyToSleep(kirby)) kirby.classList.add("k-sleep");
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
          <stop offset="0" stopColor="#f6405f" />
          <stop offset="1" stopColor="#c8143f" />
        </linearGradient>
        <linearGradient id="kArm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc6db" />
          <stop offset="1" stopColor="#f7a1c0" />
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
 * `sleepAfterMs` is his idle time before sleeping (default 2 minutes, `null` never sleeps);
 * `yawnEveryMs` plays a one-shot yawn after any welcome, then on that interval (eyes open
 * between yawns), and never under reduced motion.
 */
export function KirbyCompanion({
  size = "md",
  reaction,
  pose = "idle",
  hat,
  accessory,
  say,
  area,
  sleepAfterMs = SLEEP_AFTER_MS,
  yawnEveryMs,
  className,
}: {
  size?: keyof typeof SIZE_CLASS;
  reaction?: KirbyReaction | null;
  pose?: KirbyPose;
  hat?: KirbyHatId | null;
  accessory?: KirbyAccessory | null;
  say?: string | null;
  area?: string;
  sleepAfterMs?: number | null;
  yawnEveryMs?: number | null;
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

  useEffect(() => {
    const kirby = svgRef.current;
    if (!kirby || !yawnEveryMs) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const yawn = () => {
      clearTimeout(retry);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (kirby.classList.contains("k-sleep")) return;
      // Never cut a reaction short: try again once it has played.
      if (reacting.has(kirby)) {
        retry = setTimeout(yawn, YAWN_RETRY_MS);
        return;
      }
      play(kirby, stateTimer, "yawn");
    };
    const first = setTimeout(yawn, FIRST_YAWN_MS);
    const every = setInterval(yawn, yawnEveryMs);
    return () => {
      clearTimeout(first);
      clearTimeout(retry);
      clearInterval(every);
    };
  }, [yawnEveryMs]);

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
        data-sleep-after={sleepAfterMs ?? undefined}
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
          {/* Warp Star for the pack-ready ride: slides in under him, carries him on a lap, slides away. */}
          <g className="k-ridestar" aria-hidden="true">
            <g className="k-trail" fill="none" strokeLinecap="round" strokeWidth="3.4">
              <path d="M26 104 Q4 102 -18 94" stroke="#ff8fb4" />
              <path d="M24 111 Q2 111 -20 106" stroke="#ffd84a" />
              <path d="M26 118 Q4 120 -18 118" stroke="#7cc7f2" />
            </g>
            <path d={STAR_PATH} transform="translate(60 112) rotate(-4) scale(5.2 2.5)" fill="#f6c736" stroke="#d39a0c" strokeWidth=".45" strokeLinejoin="round" />
            <ellipse cx="44" cy="104" rx="8" ry="2.4" fill="#fff" opacity=".7" transform="rotate(-10 44 104)" />
          </g>
          <g className="k-pose tb">
            <g className="k-lean">
              {/* Red slipper feet; their own stroke, since `.k-outline` would override the attribute. */}
              <ellipse cx="39" cy="105.5" rx="20.5" ry="11" transform="rotate(-10 39 105.5)" fill="url(#kFoot)" stroke="#d65a80" strokeWidth="1.6" />
              <ellipse cx="81" cy="105.5" rx="20.5" ry="11" transform="rotate(10 81 105.5)" fill="url(#kFoot)" stroke="#d65a80" strokeWidth="1.6" />
              <g className="k-bob tb">
                {/* Small nub arms set low on the sides, tucked behind the body. */}
                <g className="arm-l" style={{ transformBox: "view-box", transformOrigin: "25px 72px" }}>
                  <ellipse className="k-outline" cx="16" cy="75.5" rx="11.5" ry="7.4" transform="rotate(-24 16 75.5)" fill="url(#kArm)" />
                </g>
                <g className="arm-r" style={{ transformBox: "view-box", transformOrigin: "95px 72px" }}>
                  <ellipse className="k-outline" cx="104" cy="75.5" rx="11.5" ry="7.4" transform="rotate(24 104 75.5)" fill="url(#kArm)" />
                </g>
                <circle className="k-body k-outline" cx="60" cy="64" r="42" fill="url(#kBody)" />
                <g className="k-look">
                  <g className="eyes-open tc">
                    <ellipse cx="50" cy="53.5" rx="6.4" ry="14.2" fill="url(#kEye)" />
                    <ellipse cx="70" cy="53.5" rx="6.4" ry="14.2" fill="url(#kEye)" />
                    <ellipse cx="50" cy="45" rx="4" ry="6.4" fill="#fff" />
                    <ellipse cx="70" cy="45" rx="4" ry="6.4" fill="#fff" />
                  </g>
                  <g className="eyes-happy" fill="none" stroke="#1a1640" strokeWidth="3.3" strokeLinecap="round">
                    <path d="M43.5 57.5 q6.5 -11 13 0" />
                    <path d="M63.5 57.5 q6.5 -11 13 0" />
                  </g>
                  <g className="eyes-sad" fill="none" stroke="#1a1640" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M45 48 l9 6 l-9 6" />
                    <path d="M75 48 l-9 6 l9 6" />
                  </g>
                  <g className="eyes-sleep" fill="none" stroke="#1a1640" strokeWidth="3" strokeLinecap="round">
                    <path d="M43.5 57 q6.5 4.6 13 0" />
                    <path d="M63.5 57 q6.5 4.6 13 0" />
                  </g>
                  {/* Yawn: eyes squeezed shut with a little tear. */}
                  <g className="eyes-squeeze" fill="none" stroke="#1a1640" strokeWidth="3" strokeLinecap="round">
                    <path d="M43 56.5 q7 -3.6 13 0.6" />
                    <path d="M77 56.5 q-7 -3.6 -13 0.6" />
                  </g>
                  <path className="k-tear" d="M41.6 58.5 q2.6 3.8 0 5.6 q-2.6 -1.8 0 -5.6z" fill="#bfe6ff" stroke="#6fb8ea" strokeWidth=".8" />
                  <g className="blush" opacity=".62">
                    <ellipse cx="36" cy="67.5" rx="7.4" ry="3.9" fill="#ff5c93" />
                    <ellipse cx="84" cy="67.5" rx="7.4" ry="3.9" fill="#ff5c93" />
                  </g>
                  {/* The same blush, puffed up for the full tummy pose (one cheek system). */}
                  <g className="k-cheeks" fill="#ff5c93">
                    <ellipse cx="36" cy="67.5" rx="9.8" ry="5.9" />
                    <ellipse cx="84" cy="67.5" rx="9.8" ry="5.9" />
                  </g>
                  <path className="mouth-closed" d="M56 71 Q60 77.6 64 71 Z" fill="#b5134a" />
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
                  <path className="mouth-doze" d="M56.5 73.5 q3.5 2.6 7 0" fill="none" stroke="#9e0f40" strokeWidth="2.2" strokeLinecap="round" />
                </g>
                {/* Asleep: a snot bubble that breathes in and out. */}
                <g className="k-snot" aria-hidden="true">
                  <circle className="tc" cx="70.5" cy="70" r="7" fill="#d9f0ff" fillOpacity=".75" stroke="#8cc6ef" strokeWidth="1.1" />
                  <ellipse cx="68" cy="67" rx="2" ry="1.3" fill="#fff" transform="rotate(-30 68 67)" />
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
        <g className="k-zzz" aria-hidden="true" fontWeight="700" fill="#7b8fc9" style={LABEL_FONT}>
          <text x="94" y="20" fontSize="15">
            z
          </text>
          <text x="104" y="6" fontSize="12">
            z
          </text>
          <text x="112" y="-6" fontSize="9.5">
            z
          </text>
        </g>
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
