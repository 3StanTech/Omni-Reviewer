/**
 * Where Kirby's tour puts the lit hole, the bubble and its tail, Kirby himself and the Warp
 * Star pointer for one step. Pure geometry: rects and the viewport in, positions out (ported
 * from the approved prototype's `layoutFor`).
 */

export type TourRect = { left: number; top: number; width: number; height: number };

export type TourHole = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
  radius: number;
};

export type TourLayoutInput = {
  /** The lit control, or null for a centred bubble (start, finish). */
  target: TourRect | null;
  /** The target's own corner radius, so a pill stays a pill and a dialog stays a card. */
  targetRadius: number;
  bubble: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Kirby shows (Dream Land); Day and Night lay out the bubble alone. */
  kirby: boolean;
  /** No veil (4b): Kirby stands on the target spot itself, no Warp Star points, and the
   * bubble sits above the target so the Generate row and its progress line stay clear. */
  open?: boolean;
  /** Study content, cards and buttons Kirby must never stand on (the mode area, the Ask pill). */
  avoid?: TourRect[];
};

export type TourLayout = {
  phone: boolean;
  /** Kirby's width in px (`lg`: 124, 84 on phones). */
  kirbySize: number;
  hole: TourHole | null;
  bubble: { left: number; top: number };
  tail: { x: number; below: boolean } | null;
  kirbySide: "left" | "right";
  kirby: { left: number; top: number } | null;
  warp: { x: number; y: number; w: number; mirror: boolean; rot: number } | null;
  /** Bubble padding on the side Kirby holds, so his body never covers the words. */
  pad: { left: number; right: number };
};

const HOLE_PAD = 8;
const GAP = 22;
/* The shelf's phone breakpoint (components/topic-shelf.tsx: a drawer below 768 px). */
const PHONE_MAX = 768;
/* Tall or combined targets (a dialog, Upload with the paste form) get a rounded rectangle, not a pill. */
const TALL_TARGET = 64;
const TALL_RADIUS = 12;
const SMALL_MAX = 640;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/** Phone width, where the shelf is a drawer and Kirby perches on the bubble. Browser only. */
export function isPhoneWidth(): boolean {
  return window.matchMedia(`(max-width: ${PHONE_MAX - 1}px)`).matches;
}

type Box = { left: number; top: number; right: number; bottom: number };
const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export function tourLayout(input: TourLayoutInput): TourLayout {
  const { width: vw, height: vh } = input.viewport;
  const { width: bw, height: bh } = input.bubble;
  const phone = vw < PHONE_MAX;
  const ks = vw < SMALL_MAX ? 84 : 124;

  let hole: TourHole | null = null;
  let bubble: { left: number; top: number };
  let tail: TourLayout["tail"] = null;
  let kirbySide: "left" | "right" = "left";

  if (!input.target) {
    bubble = { left: (vw - bw) / 2, top: clamp(vh * 0.4 - bh / 2, 90, Math.max(90, vh - bh - 40)) };
  } else {
    const r = input.target;
    const t = {
      left: r.left - HOLE_PAD,
      top: r.top - HOLE_PAD,
      right: r.left + r.width + HOLE_PAD,
      bottom: r.top + r.height + HOLE_PAD,
      width: r.width + HOLE_PAD * 2,
      height: r.height + HOLE_PAD * 2,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
    };
    const radius =
      r.height > TALL_TARGET
        ? TALL_RADIUS
        : Math.max(0, Math.min(input.targetRadius || 10, (t.height - 16) / 2)) + HOLE_PAD;
    hole = { ...t, radius };
    const fitsAbove = t.top - GAP - bh >= 16;
    const below = input.open ? !fitsAbove : t.bottom + GAP + bh + 20 <= vh || !fitsAbove;
    const right = t.cx > vw / 2;
    const left = clamp(right ? t.right - bw + 4 : t.left - 4, 16, Math.max(16, vw - 16 - bw));
    // A target too tall for either side still keeps the whole bubble (and Skip tour) on screen,
    // without a tail, since it no longer sits beside the target.
    const side = below ? t.bottom + GAP : t.top - GAP - bh;
    const top = clamp(side, 16, Math.max(16, vh - bh - 16));
    bubble = { left, top };
    tail = top === side ? { x: clamp(t.cx - left - 11, 24, Math.max(24, bw - 46)), below } : null;
    kirbySide = right ? "left" : "right";
  }

  const b = { left: bubble.left, top: bubble.top, right: bubble.left + bw, bottom: bubble.top + bh };
  // Laptops: he holds a lower corner of the bubble, away from the tail. Phones: he perches on a top corner.
  const corner = (side: "left" | "right") =>
    phone
      ? { left: side === "left" ? b.left + 10 : b.right - ks - 10, top: b.top - ks * 0.8 }
      : side === "left"
        ? { left: b.left - ks * 0.62, top: b.bottom - ks * 0.92 }
        : { left: b.right - ks * 0.38, top: b.bottom - ks * 0.92 };

  let kirby: TourLayout["kirby"] = null;
  // Whether he holds a lower corner (the bubble then pads that side for him).
  let holdsCorner = false;
  if (input.kirby) {
    if (input.open && hole) {
      // 4b: he rides home to the spot beside the Study pack text.
      kirby = { left: hole.cx - ks / 2, top: hole.cy - ks / 2 - 6 };
    } else {
      const avoid = (input.avoid ?? []).map((a) => ({ left: a.left, top: a.top, right: a.left + a.width, bottom: a.top + a.height }));
      const other = kirbySide === "left" ? "right" : "left";
      const perch = (side: "left" | "right") => ({
        left: side === "left" ? b.left + 10 : b.right - ks - 10,
        top: b.top - ks * 0.8,
      });
      // His own corner, the other corner, a perch on the bubble's top corners, then beside the bubble.
      const options: { spot: { left: number; top: number }; side: "left" | "right"; corner: boolean }[] = [
        { spot: corner(kirbySide), side: kirbySide, corner: !phone },
        { spot: corner(other), side: other, corner: !phone },
        { spot: perch(kirbySide), side: kirbySide, corner: false },
        { spot: perch(other), side: other, corner: false },
        { spot: { left: b.left - ks - 6, top: b.top }, side: "left", corner: false },
        { spot: { left: b.right + 6, top: b.top }, side: "right", corner: false },
      ];
      // Pack page, last resort: the dim strip left of the study area, level with the bubble
      // (the spot step 5 finds beside its bubble; later stops' bubbles sit over the content).
      if (avoid.length > 0) {
        const top = clamp(b.top, 56, Math.max(56, vh - ks - 4));
        const band = { top, bottom: top + ks };
        const edges = [b, ...(hole ? [hole] : []), ...avoid].filter((a) => a.top < band.bottom && a.bottom > band.top);
        const left = Math.min(...edges.map((a) => a.left)) - 8 - ks;
        options.push({ spot: { left, top }, side: "left", corner: false });
      }
      // Never on the lit target, study content or a button, and never off screen.
      const found = options.find(({ spot }) => {
        const box = { ...spot, right: spot.left + ks, bottom: spot.top + ks };
        if (box.left < 4 || box.right > vw - 4 || box.top < 56 || box.bottom > vh - 4) return false;
        if (hole && overlaps(box, hole)) return false;
        return !avoid.some((a) => overlaps(box, a));
      });
      if (found) {
        kirby = found.spot;
        kirbySide = found.side;
        holdsCorner = found.corner;
      }
    }
  }

  // The Warp Star points at the target from the first free side.
  let warp: TourLayout["warp"] = null;
  if (hole && !input.open && input.kirby) {
    const t = hole;
    const w = phone ? 58 : 74;
    const h = w / 2;
    const kr = kirby ? { left: kirby.left, top: kirby.top, right: kirby.left + ks, bottom: kirby.top + ks } : null;
    const candidates = [
      { x: t.left - w * 0.78, y: t.top - w * 0.62, mirror: false, rot: 34 },
      { x: t.right - w * 0.22, y: t.top - w * 0.62, mirror: true, rot: 34 },
      { x: t.left - w - 6, y: t.cy - h / 2, mirror: false, rot: 0 },
      { x: t.right + 6, y: t.cy - h / 2, mirror: true, rot: 0 },
    ];
    const found = candidates.find((c) => {
      const box = { left: c.x, top: c.y, right: c.x + w, bottom: c.y + h };
      return box.left >= 4 && box.right <= vw - 4 && box.top >= 60 && !overlaps(box, b) && !(kr && overlaps(box, kr));
    });
    warp = found ? { ...found, w } : null;
  }

  const sidePad = holdsCorner ? ks * 0.42 + 20 : 0;
  return {
    phone,
    kirbySize: ks,
    hole,
    bubble,
    tail,
    kirbySide,
    kirby,
    warp,
    pad: { left: kirbySide === "left" ? sidePad : 0, right: kirbySide === "right" ? sidePad : 0 },
  };
}
