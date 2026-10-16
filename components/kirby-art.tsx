import type { ReactNode } from "react";

import type { KirbyHatId } from "@/lib/kirby-hat";
import { cn } from "@/lib/utils";

/*
 * Kirby's world for the Dream Land mood: fan art drawn in SVG for this private app (never
 * Nintendo assets). Head pieces (hats, accessories, the spat star) are <g> fragments drawn in
 * Kirby's own viewBox (-12 -26 144 152; body centre 60,64, radius 42) and rendered inside
 * KirbyCompanion. World pieces are standalone, decorative (`aria-hidden`) svgs; the caller
 * gates them to Dream Land and hides them in print. Shared gradients (kFire, kTomato) live
 * in KirbyDefs so they never sit inside a hidden subtree.
 */

const OUTLINE = "#e2799f";
const STAR_FILL = "#f6c736";
const STAR_EDGE = "#d39a0c";

/** A five-point star centred on 0,0 with outer radius r. */
function starPath(r: number, inner = 0.45): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * inner;
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    points.push(`${(Math.cos(angle) * radius).toFixed(2)},${(Math.sin(angle) * radius).toFixed(2)}`);
  }
  return `M${points.join(" L")} Z`;
}

/* ---------------------------------------------------------------- head pieces */

function SwordHat() {
  return (
    <g>
      <path
        d="M24 40 Q22 6 58 2 Q90 0 104 22 Q114 34 130 60 Q112 50 100 44 Q96 40 96 37 Q62 26 24 40 Z"
        fill="#45b153"
        stroke="#2b7f35"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M38 16 Q52 6 70 8" fill="none" stroke="#8fdc8a" strokeWidth="3" strokeLinecap="round" opacity=".7" />
      <path d="M24 40 Q60 26 97 37" fill="none" stroke={STAR_FILL} strokeWidth="5.5" strokeLinecap="round" />
      <path d="M24 40 Q60 26 97 37" fill="none" stroke={STAR_EDGE} strokeWidth="1" strokeLinecap="round" opacity=".6" />
    </g>
  );
}

function BeamHat() {
  return (
    <g strokeLinejoin="round">
      <path d="M26 40 Q24 18 40 10 Q30 -2 10 -6 Q30 -16 50 2 Q56 10 60 22 Z" fill="#d6336c" stroke="#9c1f4d" strokeWidth="1.6" />
      <path d="M94 38 Q96 18 80 10 Q90 -2 110 -6 Q90 -16 70 2 Q64 10 60 22 Z" fill="#6a5ad0" stroke="#41349a" strokeWidth="1.6" />
      <path d="M26 40 Q60 24 94 38 L92 43 Q60 30 28 45 Z" fill="#fff4c2" stroke="#d39a0c" strokeWidth="1.2" />
      <circle cx="9" cy="-6" r="5.5" fill={STAR_FILL} stroke={STAR_EDGE} strokeWidth="1.2" />
      <circle cx="111" cy="-6" r="5.5" fill={STAR_FILL} stroke={STAR_EDGE} strokeWidth="1.2" />
      <path d={starPath(5)} transform="translate(60 34)" fill={STAR_FILL} stroke={STAR_EDGE} strokeWidth=".8" />
    </g>
  );
}

function FireHat() {
  return (
    <g>
      <g transform="translate(0 -5)">
        <path
          className="k-flame"
          d="M26 38 Q20 22 30 12 Q30 22 38 24 Q36 6 50 -6 Q48 10 58 16 Q60 -2 72 -10 Q68 8 76 16 Q84 4 92 4 Q86 18 92 24 Q100 18 102 12 Q106 28 94 38 Q60 26 26 38 Z"
          fill="url(#kFire)"
          stroke="#c2361c"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M44 30 Q48 18 56 14 Q56 24 62 26 Q66 18 72 14 Q72 24 78 30 Q60 24 44 30 Z" fill="#fff1a8" opacity=".85" />
      </g>
      <path d="M23 41 Q60 25 97 41" fill="none" stroke="#e0a21c" strokeWidth="7.5" strokeLinecap="round" />
      <path d="M23 41 Q60 25 97 41" fill="none" stroke="#ffd85a" strokeWidth="3" strokeLinecap="round" />
      <path d="M60 25.5 l5.4 6.4 l-5.4 6.4 l-5.4 -6.4 z" fill="#e8384f" stroke="#a51d33" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M58.6 29 l1.6 -1.8" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" opacity=".8" />
    </g>
  );
}

/** A puffy chef's toque. */
function CookHat() {
  return (
    <g stroke="#cfc6bb" strokeWidth="1.5" strokeLinejoin="round">
      <circle cx="41" cy="6" r="13" fill="#fff" />
      <circle cx="79" cy="6" r="13" fill="#fff" />
      <circle cx="60" cy="-3" r="16.5" fill="#fff" />
      <path d="M30 37 Q60 25 90 37 L89 19 Q60 9 31 19 Z" fill="#fff" />
      <path d="M47 33 L46 18 M60 30.5 L60 15.5 M73 33 L74 18" stroke="#e6ded4" strokeWidth="1.4" strokeLinecap="round" />
      <ellipse cx="52" cy="-7" rx="5" ry="3" fill="#f4efe9" stroke="none" />
    </g>
  );
}

/** Held in his right hand and tilted over his head. */
function ParasolHat() {
  return (
    <g strokeLinejoin="round">
      <path d="M77 -4 L105 70 q1.4 5.2 -3.6 5.6" fill="none" stroke="#7a4a2a" strokeWidth="3" strokeLinecap="round" />
      <g transform="translate(17 -8) rotate(16 60 0)">
        <path d="M12 12 Q20 -18 60 -22 Q100 -18 108 12 Q96 6 84 12 Q72 6 60 12 Q48 6 36 12 Q24 6 12 12 Z" fill="#fff" stroke="#c2185b" strokeWidth="1.6" />
        <path d="M36 12 Q40 -14 60 -22 Q48 -6 48 9 Z M84 12 Q80 -14 60 -22 Q72 -6 72 9 Z" fill="#e94b6f" />
        <path d="M12 12 Q16 -4 34 -14 Q26 -2 24 9 Z M108 12 Q104 -4 86 -14 Q94 -2 96 9 Z" fill="#e94b6f" />
        <circle cx="60" cy="-23" r="3" fill={STAR_FILL} stroke={STAR_EDGE} strokeWidth="1" />
      </g>
    </g>
  );
}

/** A headset with a little microphone by his mouth. */
function MikeHat() {
  return (
    <g>
      <path d="M20 58 C14 4 106 4 100 58" fill="none" stroke="#3b3550" strokeWidth="5" strokeLinecap="round" />
      <path d="M27 30 C40 14 80 14 93 30" fill="none" stroke="#6a628a" strokeWidth="1.4" strokeLinecap="round" opacity=".7" />
      <ellipse cx="19" cy="58" rx="6.2" ry="8.4" fill="#e8384f" stroke="#a51d33" strokeWidth="1.4" />
      <ellipse cx="101" cy="58" rx="6.2" ry="8.4" fill="#e8384f" stroke="#a51d33" strokeWidth="1.4" />
      <path d="M22 65 Q25 82 43 82.5" fill="none" stroke="#3b3550" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="46.5" cy="82" r="4.4" fill="#3b3550" />
      <circle cx="45.2" cy="80.6" r="1.4" fill="#fff" opacity=".6" />
    </g>
  );
}

const HATS: Record<KirbyHatId, () => ReactNode> = {
  sword: SwordHat,
  beam: BeamHat,
  fire: FireHat,
  cook: CookHat,
  parasol: ParasolHat,
  mike: MikeHat,
};

/** A copy hat on Kirby's head (inside his svg). */
export function KirbyHat({ id }: { id: KirbyHatId }) {
  const Hat = HATS[id];
  return <Hat />;
}

/** The sleepy nightcap with stars and a pom-pom (inside Kirby's svg). */
export function Nightcap() {
  return (
    <g strokeLinejoin="round">
      <path d="M24 40 Q20 8 58 4 Q86 2 104 20 Q118 36 122 62 Q108 44 98 38 Q62 26 24 40 Z" fill="#6b7fe0" stroke="#3f4fb0" strokeWidth="1.6" />
      <path d={starPath(4.2)} transform="translate(46 20)" fill="#fff6c8" />
      <path d={starPath(3.2)} transform="translate(72 14)" fill="#fff6c8" />
      <path d={starPath(3)} transform="translate(100 34) rotate(20)" fill="#fff6c8" />
      <path d="M22 41 Q60 25 99 38" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" />
      <path d="M22 41 Q60 25 99 38" fill="none" stroke="#c9d2ff" strokeWidth="1" strokeLinecap="round" />
      <circle cx="122" cy="63" r="6.5" fill="#fff" stroke="#c9d2ff" strokeWidth="1.2" />
    </g>
  );
}

/** The exam-week headband, knotted on the right (inside Kirby's svg). */
export function Headband() {
  return (
    <g strokeLinejoin="round" strokeLinecap="round">
      <path d="M21 42 Q60 22 99 42 L98 33 Q60 13 22 33 Z" fill="#e8384f" stroke="#a51d33" strokeWidth="1.4" />
      <path d={starPath(4.4)} transform="translate(60 28)" fill="#fff" />
      <path className="k-tail" d="M99 37 Q112 34 120 42 Q112 42 104 41" fill="#e8384f" stroke="#a51d33" strokeWidth="1.3" />
      <path className="k-tail" d="M99 39 Q110 46 114 56 Q106 52 100 44" fill="#e8384f" stroke="#a51d33" strokeWidth="1.3" />
      <circle cx="99" cy="38" r="3.6" fill="#c92a40" stroke="#a51d33" strokeWidth="1.2" />
    </g>
  );
}

/** The birthday party hat (inside Kirby's svg). */
export function PartyHat() {
  return (
    <g transform="rotate(12 60 20)" strokeLinejoin="round">
      <path d="M42 28 L60 -16 L78 28 Q60 34 42 28 Z" fill="#7cc7f2" stroke="#3a8fc4" strokeWidth="1.6" />
      <path d="M49 11 L71 11 L74 18 L46 18 Z" fill="#ffb3cc" />
      <path d="M54 -1 L66 -1 L68 4 L52 4 Z" fill="#fff07a" />
      <path d="M42 28 Q60 34 78 28" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <circle cx="60" cy="-17" r="5" fill="#ff7aa5" stroke="#c2185b" strokeWidth="1.2" />
    </g>
  );
}

/** The star Kirby spits after five quick taps (inside Kirby's svg, starts at his mouth). */
export function StarSpit() {
  return (
    <g transform="translate(66 74)">
      <path className="k-spitstar tc" d={starPath(9)} fill={STAR_FILL} stroke={STAR_EDGE} strokeWidth="1.2" strokeLinejoin="round" />
    </g>
  );
}

/* ---------------------------------------------------------------- world pieces */

function Art({ viewBox, className, children }: { viewBox: string; className?: string; children: ReactNode }) {
  return (
    <svg viewBox={viewBox} className={cn("kirby-art", className)} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Birthday cake with one candle. */
export function BirthdayCake({ className }: { className?: string }) {
  return (
    <Art viewBox="0 0 48 52" className={className}>
      <ellipse cx="24" cy="46" rx="21" ry="4" fill="#fff" stroke={OUTLINE} strokeWidth="1.2" />
      <rect x="8" y="26" width="32" height="18" rx="3" fill="#fff5e8" stroke={OUTLINE} strokeWidth="1.3" />
      <rect x="8" y="34" width="32" height="3.5" fill="#ffb3cc" />
      <path d="M8 29 Q8 24 12 24 L36 24 Q40 24 40 29 Q37 33 34 29 Q31 33 28 29 Q25 33 22 29 Q19 33 16 29 Q13 33 10 29 Z" fill="#ff8fb4" stroke={OUTLINE} strokeWidth="1.1" strokeLinejoin="round" />
      <circle cx="14" cy="23" r="2.6" fill="#e8384f" />
      <circle cx="34" cy="23" r="2.6" fill="#e8384f" />
      <rect x="22" y="10" width="4" height="14" rx="1.2" fill="#7cc7f2" stroke="#3a8fc4" strokeWidth=".9" />
      <path d="M22 14 L26 12 M22 19 L26 17" stroke="#fff" strokeWidth="1.2" />
      <path className="cake-flame" d="M24 1 Q28.5 6 24 9.5 Q19.5 6 24 1 Z" fill="#ffb02e" stroke="#e8701a" strokeWidth=".8" />
    </Art>
  );
}

/** Waddle Dee, Kirby's helper; `holding="page"` holds up a page (loading states). */
export function WaddleDee({ className, holding }: { className?: string; holding?: "page" | null }) {
  return (
    <Art viewBox="0 0 64 66" className={cn("waddle-dee", className)}>
      <ellipse cx="32" cy="62" rx="20" ry="3" fill="#000" opacity=".08" />
      <ellipse cx="21" cy="57" rx="10" ry="5.5" fill="#f6c44f" stroke="#c18a12" strokeWidth="1.3" />
      <ellipse cx="43" cy="57" rx="10" ry="5.5" fill="#f6c44f" stroke="#c18a12" strokeWidth="1.3" />
      <circle cx="32" cy="32" r="23" fill="#f5913e" stroke="#c4621c" strokeWidth="1.5" />
      <ellipse cx="32" cy="37" rx="16.5" ry="13.5" fill="#ffe3c4" />
      <ellipse cx="26" cy="35" rx="2.8" ry="5" fill="#3b2416" />
      <ellipse cx="38" cy="35" rx="2.8" ry="5" fill="#3b2416" />
      <ellipse cx="26.6" cy="32.6" rx="1.1" ry="1.6" fill="#fff" />
      <ellipse cx="38.6" cy="32.6" rx="1.1" ry="1.6" fill="#fff" />
      <ellipse cx="19" cy="42" rx="3.4" ry="2" fill="#ff8f7a" opacity=".7" />
      <ellipse cx="45" cy="42" rx="3.4" ry="2" fill="#ff8f7a" opacity=".7" />
      {holding === "page" ? (
        <g className="wd-page">
          <g transform="rotate(-6 32 50)">
            <rect x="19" y="40" width="26" height="20" rx="2" fill="#fff" stroke="#b8a48e" strokeWidth="1.2" />
            <path d="M23 46 H41 M23 50 H41 M23 54 H35" stroke="#c9c1b6" strokeWidth="1.4" strokeLinecap="round" />
          </g>
          <ellipse cx="18" cy="49" rx="5" ry="4.2" fill="#f5913e" stroke="#c4621c" strokeWidth="1.2" />
          <ellipse cx="46" cy="47" rx="5" ry="4.2" fill="#f5913e" stroke="#c4621c" strokeWidth="1.2" />
        </g>
      ) : (
        <>
          <ellipse cx="9" cy="38" rx="5" ry="4.2" fill="#f5913e" stroke="#c4621c" strokeWidth="1.2" />
          <ellipse cx="55" cy="38" rx="5" ry="4.2" fill="#f5913e" stroke="#c4621c" strokeWidth="1.2" />
        </>
      )}
    </Art>
  );
}

/** The Warp Star, with a rainbow trail to its left unless `trail` is false. */
export function WarpStar({ className, trail = true }: { className?: string; trail?: boolean }) {
  return (
    <Art viewBox={trail ? "0 0 52 32" : "24 2 28 28"} className={className}>
      {trail ? (
        <g fill="none" strokeLinecap="round" strokeWidth="2.6">
          <path d="M4 10 Q16 12 28 14" stroke="#ff8fb4" />
          <path d="M2 16 Q15 16 27 17" stroke="#ffd84a" />
          <path d="M4 22 Q16 20 28 20" stroke="#7cc7f2" />
        </g>
      ) : null}
      <path d={starPath(12.5, 0.5)} transform="translate(38 16) rotate(-8)" fill={STAR_FILL} stroke={STAR_EDGE} strokeWidth="1.4" strokeLinejoin="round" />
      <ellipse cx="35" cy="12" rx="3" ry="2" fill="#fff" opacity=".7" transform="rotate(-30 35 12)" />
    </Art>
  );
}

export const CAFE_TREATS = ["shortcake", "pudding", "cookie", "parfait", "donut", "macaron", "pancakes"] as const;

export type CafeTreatKind = (typeof CAFE_TREATS)[number];

/** full: the treat; outline: today's treat waiting; plate: an empty plate (missed); faint: a future plate. */
export type CafeTreatState = "full" | "outline" | "plate" | "faint";

type Paint = (fill: string, stroke?: string) => { fill: string; stroke?: string; strokeWidth?: number };

const TREAT_DRAW: Record<CafeTreatKind, (p: Paint) => ReactNode> = {
  shortcake: (p) => (
    <>
      <path d="M8 31 L8 20 L32 20 L32 31 Z" {...p("#f6d58e", "#d0a556")} />
      <rect x="8" y="17.5" width="24" height="3.5" {...p("#fff", "#e8c9d6")} />
      <rect x="8" y="24.5" width="24" height="2" {...p("#fff")} />
      <path d="M20 9.5 Q25 11 23.5 16 Q20 19 16.5 16 Q15 11 20 9.5 Z" {...p("#e8384f", "#b5172f")} />
      <path d="M17.5 10.5 L20 8 L22.5 10.5" {...p("none", "#3d9c45")} />
    </>
  ),
  pudding: (p) => (
    <>
      <path d="M10 31 L13 16.5 Q20 13.5 27 16.5 L30 31 Z" {...p("#fbe08a", "#d4a73a")} />
      <path d="M13 16.5 Q20 13.5 27 16.5 L26.2 20.5 Q20 18 13.8 20.5 Z" {...p("#a5571b", "#7a3c0e")} />
      <circle cx="20" cy="12.5" r="2.6" {...p("#e8384f", "#b5172f")} />
    </>
  ),
  cookie: (p) => (
    <>
      <path d={starPath(11.5, 0.55)} transform="translate(20 22)" {...p("#e9b464", "#b9822f")} strokeLinejoin="round" />
      <circle cx="17" cy="20" r="1.1" {...p("#ff8fb4")} />
      <circle cx="23" cy="22" r="1.1" {...p("#7cc7f2")} />
      <circle cx="19.5" cy="25.5" r="1.1" {...p("#fff")} />
    </>
  ),
  parfait: (p) => (
    <>
      <path d="M17 31 L23 31 L21.2 27 L18.8 27 Z" {...p("#d9eef9", "#9fc6dc")} />
      <path d="M12 12 L28 12 L24.5 27 L15.5 27 Z" {...p("#eaf6fc", "#9fc6dc")} />
      <path d="M13.2 17 L26.8 17 L25.6 22 L14.4 22 Z" {...p("#ffb3cc")} />
      <path d="M14.4 22 L25.6 22 L24.5 27 L15.5 27 Z" {...p("#a5571b")} />
      <path d="M11.5 12 Q14 7 20 7.5 Q26 7 28.5 12 Z" {...p("#fff", "#e8c9d6")} />
      <circle cx="20" cy="5.5" r="2.6" {...p("#e8384f", "#b5172f")} />
    </>
  ),
  donut: (p) => (
    <>
      <circle cx="20" cy="22" r="10.5" {...p("#e9b464", "#b9822f")} />
      <path d="M10.5 21 Q11 12.5 20 12 Q29 12.5 29.5 21 Q27 24 25 21.5 Q23 25 20 22.5 Q17 25 15 21.5 Q13 24 10.5 21 Z" {...p("#ff8fb4", "#d9668f")} />
      <circle cx="20" cy="21.5" r="3.4" {...p("#fff", "#b9822f")} />
      <path d="M14 16 L15.5 17 M24 15 L25.5 16.5 M18 14 L19 15.5" {...p("none", "#fff")} />
    </>
  ),
  macaron: (p) => (
    <>
      <ellipse cx="20" cy="26" rx="11" ry="4.6" {...p("#ffb3cc", "#d9668f")} />
      <rect x="10" y="20.5" width="20" height="4" rx="1.5" {...p("#fff5e8", "#e8c9d6")} />
      <ellipse cx="20" cy="18.5" rx="11" ry="5" {...p("#ffb3cc", "#d9668f")} />
      <path d="M10 21 Q20 23.5 30 21" {...p("none", "#d9668f")} />
    </>
  ),
  pancakes: (p) => (
    <>
      <ellipse cx="20" cy="27" rx="12" ry="3.6" {...p("#e9b464", "#b9822f")} />
      <ellipse cx="20" cy="23" rx="12" ry="3.6" {...p("#efc37a", "#b9822f")} />
      <ellipse cx="20" cy="19" rx="12" ry="3.6" {...p("#f3cf8c", "#b9822f")} />
      <path d="M13 18.5 Q20 21 27 18.5 L27 22 Q25.5 24 24.5 21.5 Q22 23 21 20.5" {...p("#a5571b")} />
      <rect x="17.5" y="15" width="5" height="3.5" rx="1" {...p("#fff07a", "#d4b62a")} />
    </>
  ),
};

/** One Café treat on its plate for the week row (Mon shortcake through Sun pancakes). */
export function CafeTreat({ kind, state, className }: { kind: CafeTreatKind; state: CafeTreatState; className?: string }) {
  const outline = state === "outline";
  const paint: Paint = (fill, stroke) =>
    outline
      ? { fill: "none", stroke: OUTLINE, strokeWidth: 1.1 }
      : stroke
        ? { fill, stroke, strokeWidth: 1 }
        : { fill };
  return (
    <Art viewBox="0 0 40 38" className={cn(state === "faint" && "opacity-40", className)}>
      <ellipse cx="20" cy="32" rx="16.5" ry="4.5" fill="#fff" stroke="#e8c9d6" strokeWidth="1.2" />
      <ellipse cx="20" cy="31.6" rx="10" ry="2.2" fill="none" stroke="#f3dce6" strokeWidth="1" />
      {state === "full" || outline ? <g strokeDasharray={outline ? "2.2 1.8" : undefined}>{TREAT_DRAW[kind](paint)}</g> : null}
    </Art>
  );
}

/** Maxim Tomato, shown beside a 3-day streak. */
export function MaximTomato({ className }: { className?: string }) {
  return (
    <Art viewBox="0 0 40 40" className={className}>
      <circle cx="20" cy="23" r="14.5" fill="url(#kTomato)" stroke="#9c1019" strokeWidth="1.2" />
      <ellipse cx="14" cy="16" rx="4" ry="2.4" fill="#fff" opacity=".55" transform="rotate(-30 14 16)" />
      <path d="M13 30 L13 18 L20 25 L27 18 L27 30" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 9.5 L16 5 L19 9 L13 8 L18.5 10.5 L20 6 L21.5 10.5 L27 8 L21 9 L24 5 Z" fill="#3d9c45" stroke="#25702c" strokeWidth=".9" strokeLinejoin="round" />
    </Art>
  );
}

/** Green Greens: rolling hills for the bottom of the desk page. */
export function GreenGreensHills({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1200 120" preserveAspectRatio="xMidYMax slice" className={cn("kirby-art", className)} aria-hidden="true" focusable="false">
      <path d="M0 70 Q140 20 300 58 Q430 88 560 46 Q700 6 860 52 Q1000 88 1200 40 L1200 120 L0 120 Z" fill="#c9eeb3" />
      <path d={starPath(6)} transform="translate(210 26)" fill="#fff07a" opacity=".8" />
      <path d={starPath(5)} transform="translate(980 22)" fill="#fff07a" opacity=".8" />
      <path d={starPath(4)} transform="translate(640 18)" fill="#fff07a" opacity=".7" />
      <g>
        <path d="M150 74 L150 50" stroke="#8a5a34" strokeWidth="5" strokeLinecap="round" />
        <circle cx="150" cy="40" r="18" fill="#6fc35f" stroke="#3f8f37" strokeWidth="2" />
        <path d="M770 56 L770 32" stroke="#8a5a34" strokeWidth="5" strokeLinecap="round" />
        <circle cx="770" cy="22" r="16" fill="#6fc35f" stroke="#3f8f37" strokeWidth="2" />
      </g>
      <path d="M0 96 Q180 56 380 90 Q560 120 760 80 Q960 46 1200 86 L1200 120 L0 120 Z" fill="#94d77f" stroke="#5fae4f" strokeWidth="2" />
      <g>
        <path d="M480 100 L480 80" stroke="#8a5a34" strokeWidth="5" strokeLinecap="round" />
        <circle cx="480" cy="70" r="15" fill="#5bb34c" stroke="#3f8f37" strokeWidth="2" />
      </g>
      <g fill="#fff">
        <circle cx="250" cy="104" r="3" />
        <circle cx="620" cy="106" r="3" />
        <circle cx="1060" cy="100" r="3" />
      </g>
      <g fill="#ff8fb4">
        <circle cx="262" cy="108" r="2.6" />
        <circle cx="900" cy="98" r="2.6" />
      </g>
    </svg>
  );
}
