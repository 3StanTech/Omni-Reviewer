"use client";

import { useEffect, useRef, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

/*
 * Kirby companion for the Dream Land mood: fan art drawn in SVG for this private app.
 * Shown only in Dream Land through CSS (`hidden dreamland:block`), so there is no flash
 * or hydration mismatch. Animation states are classes on the svg set through a ref
 * (no re-render); the rules and keyframes live in app/globals.css under `.kirby-companion`.
 */

export type KirbyReaction = { outcome: "happy" | "sad"; key: number };

type KirbyState = "press" | "happy" | "sad";

const STATE_MS: Record<KirbyState, number> = { press: 1000, happy: 1300, sad: 1500 };
const SLEEP_AFTER_MS = 20_000;

const SIZE_CLASS = {
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

/* One passive pointermove listener and one idle timer serve every mounted Kirby. */
const instances = new Set<SVGSVGElement>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function sleepAll() {
  for (const kirby of instances) kirby.classList.add("k-sleep");
}

function wake() {
  for (const kirby of instances) kirby.classList.remove("k-sleep");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(sleepAll, SLEEP_AFTER_MS);
}

function followPointer(event: PointerEvent) {
  wake();
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

function register(kirby: SVGSVGElement) {
  instances.add(kirby);
  if (instances.size === 1) {
    window.addEventListener("pointermove", followPointer, { passive: true });
  }
  wake();
}

function unregister(kirby: SVGSVGElement) {
  instances.delete(kirby);
  if (instances.size === 0) {
    window.removeEventListener("pointermove", followPointer);
    clearTimeout(idleTimer);
  }
}

/** Plays one timed state; the reflow restarts it when the same state plays twice in a row. */
function play(
  kirby: SVGSVGElement,
  timer: { current: ReturnType<typeof setTimeout> | undefined },
  state: KirbyState,
) {
  kirby.classList.remove("k-happy", "k-sad", "k-press", "k-sleep");
  void kirby.getBoundingClientRect();
  kirby.classList.add(`k-${state}`);
  clearTimeout(timer.current);
  timer.current = setTimeout(() => kirby.classList.remove(`k-${state}`), STATE_MS[state]);
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
      </defs>
    </svg>
  );
}

export function KirbyCompanion({
  size = "md",
  reaction,
  className,
}: {
  size?: "sm" | "md" | "lg";
  reaction?: KirbyReaction | null;
  className?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  const reactionKey = reaction?.key;
  const reactionOutcome = reaction?.outcome;
  useEffect(() => {
    if (reactionKey === undefined || !reactionOutcome || !svgRef.current) return;
    play(svgRef.current, stateTimer, reactionOutcome);
  }, [reactionKey, reactionOutcome]);

  return (
    <div className={cn("kirby-companion hidden dreamland:block print:hidden", SIZE_CLASS[size], className)}>
      <svg
        ref={svgRef}
        className="kirby"
        viewBox="-12 -26 144 152"
        role="img"
        aria-label="Kirby"
        onPointerEnter={() => svgRef.current?.classList.add("k-hover")}
        onPointerLeave={() => svgRef.current?.classList.remove("k-hover")}
        onClick={(event) => play(event.currentTarget, stateTimer, "press")}
      >
        <ellipse cx="60" cy="118" rx="34" ry="4.5" fill="#000" opacity=".08" />
        <g className="k-jump tc">
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
              <circle className="k-outline" cx="60" cy="64" r="42" fill="url(#kBody)" />
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
                <path className="mouth-closed" d="M55.5 71 Q60 77.5 64.5 71 Z" fill="#b5134a" />
                <g className="mouth-open">
                  <ellipse cx="60" cy="75" rx="6.5" ry="7.2" fill="#9e0f40" />
                  <ellipse cx="60" cy="79.2" rx="4" ry="2.6" fill="#ff7aa5" />
                </g>
                <path className="mouth-sad" d="M53 76 q3.5 -3 7 0 q3.5 3 7 0" fill="none" stroke="#9e0f40" strokeWidth="2.4" strokeLinecap="round" />
              </g>
            </g>
          </g>
        </g>
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
