"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { SpeakerHigh, SpeakerSlash, Star } from "@phosphor-icons/react";

import { useLook } from "@/components/look-provider";
import { STATE_MS, STAR_PATH } from "@/components/kirby-companion";
import { TourKirby, type TourKirbyHandle } from "@/components/tour/tour-kirby";
import { useTour, type TourApi } from "@/components/tour/tour-provider";
import { Button } from "@/components/ui/button";
import { REPLAY_START, REPLAY_STOPS, TOUR_STEPS, TOUR_TOTAL, type TourStepId, type TourTarget } from "@/lib/tour";
import { tourLayout, type TourLayout, type TourRect } from "@/lib/tour-layout";
import { useIsClient } from "@/lib/use-is-client";
import { cn } from "@/lib/utils";

/* Bubble chrome, word for word from the approved copy (content.md). */
const LABELS = {
  name: "Kirby",
  start: "Start tour",
  notNow: "Not now",
  done: "Done",
  skip: "Skip tour",
  back: "Back",
  next: "Next",
  mute: "Mute music",
  unmute: "Play music",
} as const;

/* A finished step's victory jump plays before he rides on. */
const CHEER_MS = 900;
const HOP_EVERY_MS = 1600;
const RELAYOUT_EVERY_MS = 300;
const HOLE_MOVE_MS = 900;
/* Wave 3 reactions (prototype `live.js`): the wander nudge, puzzled on a dim click, idle, pages. */
const WANDER_MS = 2500;
const NUDGE_EVERY_MS = 4000;
const PUZZLED_MS = 1300;
const IDLE_BOUNCE_MS = 10_000;
const IDLE_YAWN_MS = 40_000;
const PAGE_EVERY_MS = 420;
const PAGE_FLIGHT_MS = 1100;
/* The bubble's CSS width (app/globals.css `.tour-bubble`), used until it has been measured. */
const BUBBLE_WIDTH = 360;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** What the bubble shows and lights: a first-visit step, or a replay stop. */
type View = {
  key: string;
  step: TourStepId;
  kind: "start" | "finish" | "step" | "replay";
  target: TourTarget | null;
  title: string;
  line: string;
  number: number | null;
  total: number;
  open?: boolean;
  link?: { label: string; target: TourTarget };
};

function viewFor(step: TourStepId | null, replay: TourApi["replay"]): View | null {
  if (!step || step === "interlude") return null;
  const def = TOUR_STEPS[step];
  if (replay) {
    if (step === "start") {
      return { key: "replay-start", step, kind: "start", target: null, title: REPLAY_START.title, line: REPLAY_START.line, number: null, total: replay.total };
    }
    if (step === "finish" || replay.stop === null) {
      return { key: "replay-finish", step: "finish", kind: "finish", target: null, title: TOUR_STEPS.finish.title, line: TOUR_STEPS.finish.line, number: null, total: replay.total };
    }
    const stop = REPLAY_STOPS[replay.stop - 1];
    return { key: `replay-${stop.id}`, step, kind: "replay", target: stop.target, title: def.title, line: def.line, number: replay.stop, total: replay.total };
  }
  return {
    key: step,
    step,
    kind: step === "start" ? "start" : step === "finish" ? "finish" : "step",
    target: def.target,
    title: def.title,
    line: def.line,
    number: def.number,
    total: TOUR_TOTAL,
    open: def.open,
    link: def.link,
  };
}

function visibleTargets(name: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour-target="${name}"]`)).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

/**
 * The elements a view lights. Step 3 lights Upload and Paste together (and the paste form once
 * open). In 4b the Study pack Kirby's spot is empty outside Dream Land (and absent once the
 * free requests are used up), so the bubble sits by Generate instead.
 */
/**
 * Scrolls a sideways-scrolling strip just enough to show a lit control it clips (the mode tabs
 * on a narrow laptop, once Locked In or Summary adds its tools). The page itself never moves.
 */
function revealSideways(el: HTMLElement) {
  for (let strip = el.parentElement; strip; strip = strip.parentElement) {
    if (strip.scrollWidth <= strip.clientWidth || !/auto|scroll/.test(getComputedStyle(strip).overflowX)) continue;
    const box = strip.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    if (rect.left < box.left) strip.scrollLeft -= box.left - rect.left;
    else if (rect.right > box.right) strip.scrollLeft += rect.right - box.right;
    return;
  }
}

function viewElements(view: View): HTMLElement[] {
  if (!view.target) return [];
  if (view.kind === "step" && view.step === "upload") {
    const upload = visibleTargets("upload")[0];
    if (!upload) return [];
    const extra = [visibleTargets("paste")[0], document.querySelector<HTMLElement>("#source-paste-form:not([hidden])")];
    return [upload, ...extra.filter((el): el is HTMLElement => Boolean(el))];
  }
  if (view.kind === "step" && view.step === "generating") {
    const spot = visibleTargets("study-pack-kirby")[0] ?? visibleTargets("generate")[0];
    return spot ? [spot] : [];
  }
  const el = visibleTargets(view.target)[0];
  return el ? [el] : [];
}

function toRect(rect: DOMRect): TourRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function unionRect(elements: HTMLElement[]): TourRect | null {
  if (elements.length === 0) return null;
  const rects = elements.map((el) => el.getBoundingClientRect());
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

/** Study content and the Ask pill (unless lit), where Kirby never stands. */
function avoidRects(lit: HTMLElement[]): TourRect[] {
  const areas = Array.from(document.querySelectorAll<HTMLElement>("[data-tour-avoid], [data-ask-pill]"));
  return areas
    .filter((el) => !lit.some((target) => el === target || el.contains(target)))
    .map((el) => toRect(el.getBoundingClientRect()))
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

function layoutKey(layout: TourLayout): string {
  return JSON.stringify(layout, (_key, value: unknown) => (typeof value === "number" ? Math.round(value) : value));
}

const FOCUSABLE = "button, a[href], input, textarea, select, [tabindex]";

type Placed = { key: string; layout: TourLayout; bubbleWidth: number };

/** Restarts a one-shot CSS animation class. */
function restartAnimation(el: Element | null, cls: string) {
  if (!el) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

/**
 * The tour's spotlight over the real app: a veil with four blocker panels around the lit gap
 * (so the lit control keeps its own events), a stitched ring, Kirby's bubble with its tail, the
 * Warp Star pointer and the guide Kirby. Placement comes from `lib/tour-layout.ts`.
 */
export function TourLayer() {
  const tour = useTour();
  const look = useLook();
  const isClient = useIsClient();
  const dreamland = look === "dreamland";
  const view = viewFor(tour?.step ?? null, tour?.replay ?? null);
  const viewKey = view?.key ?? null;
  const step = tour?.step ?? null;

  const [shown, setShown] = useState<View | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [bubbleOut, setBubbleOut] = useState(true);
  const [guideHidden, setGuideHidden] = useState(true);
  const [holeMoving, setHoleMoving] = useState(false);

  const layerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const holeRef = useRef<HTMLDivElement>(null);
  const kirbyRef = useRef<TourKirbyHandle>(null);
  const viewRef = useRef<View | null>(null);
  const prevStepRef = useRef<TourStepId | null>(null);
  const settledRef = useRef(false);
  const placedRef = useRef(placed);
  const dreamlandRef = useRef(dreamland);
  const lastHop = useRef(0);
  const lastNudge = useRef(0);
  const wanderTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    placedRef.current = placed;
    dreamlandRef.current = dreamland;
  });

  const measure = useCallback((forView: View): TourLayout | null => {
    const elements = viewElements(forView);
    const rect = unionRect(elements);
    if (forView.target && !rect) return null;
    const bubble = bubbleRef.current;
    // Several lit controls make a rounded rectangle, never a pill that clips their corners.
    const radius =
      elements.length > 1 ? 4 : elements[0] ? parseFloat(getComputedStyle(elements[0]).borderTopLeftRadius) || 10 : 10;
    return tourLayout({
      target: rect,
      targetRadius: radius,
      bubble: { width: bubble?.offsetWidth ?? BUBBLE_WIDTH, height: bubble?.offsetHeight ?? 160 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      kirby: dreamlandRef.current,
      open: forView.open,
      avoid: avoidRects(elements),
    });
  }, []);

  /** Re-places the current view without animation (resize, scroll, a row appearing). */
  const relayout = useCallback(() => {
    const current = viewRef.current;
    if (!current) return;
    const first = viewElements(current)[0];
    if (first) revealSideways(first);
    const layout = measure(current);
    if (!layout) return;
    const previous = placedRef.current;
    const width = bubbleRef.current?.offsetWidth ?? BUBBLE_WIDTH;
    if (
      !previous ||
      previous.key !== current.key ||
      previous.bubbleWidth !== width ||
      layoutKey(previous.layout) !== layoutKey(layout)
    ) {
      const next = { key: current.key, layout, bubbleWidth: width };
      placedRef.current = next;
      setPlaced(next);
    }
    if (settledRef.current) {
      if (layout.kirby) kirbyRef.current?.place(layout.kirby);
      // No free spot beside the bubble: he steps away rather than stand on study content.
      setGuideHidden(!layout.kirby || (current.kind === "step" && current.step === "generating"));
    }
  }, [measure]);

  // Each new view: the hole moves at once (the real control is usable right away); the bubble
  // hides while Kirby cheers the finished step, then he rides to his new spot and it returns.
  useEffect(() => {
    const previous = prevStepRef.current;
    prevStepRef.current = step;
    const current = viewFor(step, tour?.replay ?? null);
    viewRef.current = current;
    if (!current) {
      settledRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBubbleOut(true);
      setGuideHidden(true);
      setShown(null);
      return;
    }
    let cancelled = false;
    const motion = !reducedMotion();
    settledRef.current = false;
    setBubbleOut(true);

    const first = viewElements(current)[0];
    if (first && !first.closest('[role="dialog"]')) {
      const rect = first.getBoundingClientRect();
      if (rect.top < 70 || rect.bottom > window.innerHeight - 20) first.scrollIntoView({ block: "center" });
    }
    setHoleMoving(motion);
    const holeTimer = window.setTimeout(() => setHoleMoving(false), HOLE_MOVE_MS);
    relayout();

    void (async () => {
      const kirby = kirbyRef.current;
      if (previous === "interlude") {
        // After the pack-ready cheer he comes back beside the first study mode and dances.
        await frame();
        if (cancelled) return;
        const layout = measure(current);
        if (layout?.kirby) {
          kirby?.place(layout.kirby);
          setGuideHidden(false);
          kirby?.play("dance");
          await sleep(motion ? STATE_MS.dance : 0);
        }
      } else if (previous && previous !== current.step && current.kind === "step") {
        kirby?.play("happy");
        await sleep(motion ? CHEER_MS : 0);
      }
      if (cancelled) return;
      setShown(current);
      await frame();
      await frame();
      // A target can arrive late (a dialog opening, a page loading): wait for it.
      let layout: TourLayout | null = null;
      while (!cancelled) {
        relayout();
        layout = placedRef.current?.key === current.key ? placedRef.current.layout : null;
        if (layout) break;
        await sleep(150);
      }
      if (cancelled || !layout) return;
      if (layout.kirby && kirby) {
        if (!kirby.placed()) {
          // His first stop starts from the Kirby whose area he takes over.
          const home = document.querySelector<HTMLElement>('[data-tour-home="desk"]') ?? visibleTargets("study-pack-kirby")[0];
          const rect = home?.getBoundingClientRect();
          kirby.place(rect && rect.width > 0 ? { left: rect.left, top: rect.top } : layout.kirby);
        }
        setGuideHidden(false);
        await kirby.travel(layout.kirby);
      }
      if (cancelled) return;
      // 4b: he has handed over to the Study pack Kirby, who inhales in his place.
      setGuideHidden(!layout.kirby || (current.kind === "step" && current.step === "generating"));
      settledRef.current = true;
      setBubbleOut(false);
      if (current.kind === "start") kirby?.play("wave");
      if (current.kind === "finish") kirby?.play("dance");
      const target = viewElements(current)[0];
      if (target && target.matches(FOCUSABLE) && !target.closest('[role="dialog"]') && !document.activeElement?.closest('[role="dialog"]')) {
        target.focus({ preventScroll: true });
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(holeTimer);
    };
    // The view key captures every change that moves the tour on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, measure, relayout]);

  // Re-place on resize, any scroll, and the target or bubble changing size; a slow tick catches
  // targets that appear late (a dialog opening, the pack page loading).
  useEffect(() => {
    const current = viewRef.current;
    if (!current) return;
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        relayout();
      });
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    const observer = new ResizeObserver(schedule);
    for (const el of viewElements(current)) observer.observe(el);
    if (bubbleRef.current) observer.observe(bubbleRef.current);
    const tick = window.setInterval(schedule, RELAYOUT_EVERY_MS);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      observer.disconnect();
      window.clearInterval(tick);
    };
  }, [viewKey, relayout]);

  /** He points back at the lit control: the bubble wiggles and the ring pulses. */
  const nudge = useCallback(() => {
    wanderTimer.current = undefined;
    if (!settledRef.current || !dreamlandRef.current || reducedMotion()) return;
    if (Date.now() - lastNudge.current < NUDGE_EVERY_MS) return;
    lastNudge.current = Date.now();
    kirbyRef.current?.armUp(true);
    restartAnimation(bubbleRef.current, "wiggle");
    restartAnimation(holeRef.current, "pulse");
  }, []);

  // Hovering the lit control: the ring glows gold and Kirby hops with a "poyo!". Wandering on the
  // veil for a while makes him point back; idle, he bounces at 10 s and yawns at 40 s.
  useEffect(() => {
    if (!viewKey) return;
    let idle: number[] = [];
    const restartIdle = () => {
      idle.forEach((timer) => window.clearTimeout(timer));
      idle = [];
      if (reducedMotion()) return;
      idle = [
        window.setTimeout(() => {
          if (!settledRef.current || !dreamlandRef.current) return;
          kirbyRef.current?.play("press");
          restartAnimation(bubbleRef.current, "bounce");
        }, IDLE_BOUNCE_MS),
        window.setTimeout(() => {
          if (settledRef.current && dreamlandRef.current) kirbyRef.current?.play("yawn");
        }, IDLE_YAWN_MS),
      ];
    };
    function onMove(event: PointerEvent) {
      restartIdle();
      const hole = placedRef.current?.key === viewRef.current?.key ? placedRef.current?.layout.hole : null;
      const ring = holeRef.current;
      if (!hole || !ring) return;
      const hot =
        event.clientX >= hole.left && event.clientX <= hole.right && event.clientY >= hole.top && event.clientY <= hole.bottom;
      ring.classList.toggle("hot", hot);
      if (hot) {
        window.clearTimeout(wanderTimer.current);
        wanderTimer.current = undefined;
        kirbyRef.current?.armUp(false);
        if (settledRef.current && dreamlandRef.current && Date.now() - lastHop.current > HOP_EVERY_MS) {
          lastHop.current = Date.now();
          kirbyRef.current?.play("press");
        }
        return;
      }
      if ((event.target as Element | null)?.classList?.contains("tour-blocker") && wanderTimer.current === undefined) {
        wanderTimer.current = window.setTimeout(nudge, WANDER_MS);
      }
    }
    restartIdle();
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("keydown", restartIdle);
    return () => {
      idle.forEach((timer) => window.clearTimeout(timer));
      window.clearTimeout(wanderTimer.current);
      wanderTimer.current = undefined;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", restartIdle);
    };
  }, [viewKey, nudge]);

  // Replay: the topics and New pack stops only show where things are, so pressing them moves on
  // instead of opening a topic or the New pack dialog (nothing is created in a replay).
  const replayShowOnly = view?.kind === "replay" && (view.target === "topics" || view.target === "new-pack");
  const next = tour?.next;
  useEffect(() => {
    if (!replayShowOnly || !next) return;
    const current = viewRef.current;
    function onClick(event: MouseEvent) {
      if (!current || !settledRef.current) return;
      const lit = viewElements(current);
      if (!lit.some((el) => el.contains(event.target as Node))) return;
      event.preventDefault();
      event.stopPropagation();
      next?.();
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [replayShowOnly, viewKey, next]);

  // 4b: pages fly from the handout into the Study pack Kirby's mouth while he inhales.
  const inhaling = Boolean(view?.kind === "step" && view.step === "generating" && !bubbleOut && dreamland);
  useEffect(() => {
    if (!inhaling || reducedMotion()) return;
    const timer = window.setInterval(() => {
      const layer = layerRef.current;
      const mouthEl = visibleTargets("study-pack-kirby")[0]?.querySelector("svg.kirby");
      const fromEl = visibleTargets("source-row")[0];
      if (!layer || !mouthEl || !fromEl) return;
      const m = mouthEl.getBoundingClientRect();
      const f = fromEl.getBoundingClientRect();
      const mx = m.left + m.width * 0.5;
      const my = m.top + m.height * 0.62;
      const sx = f.left + 30 + Math.random() * Math.max(20, Math.min(200, f.width - 60));
      const sy = f.top + 10 + Math.random() * 20;
      const page = document.createElement("span");
      page.className = "tour-page";
      layer.append(page);
      page
        .animate(
          [
            { transform: `translate(${sx}px, ${sy}px) rotate(0deg) scale(1)`, opacity: 0 },
            { opacity: 1, offset: 0.15 },
            { transform: `translate(${(sx + mx) / 2}px, ${Math.min(sy, my) - 40}px) rotate(${Math.random() * 120 - 60}deg) scale(.8)`, offset: 0.55 },
            { transform: `translate(${mx - 8}px, ${my - 10}px) rotate(180deg) scale(.15)`, opacity: 0.2 },
          ],
          { duration: PAGE_FLIGHT_MS, easing: "cubic-bezier(.5,0,.75,.4)" },
        )
        .finished.catch(() => undefined)
        .finally(() => page.remove());
    }, PAGE_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [inhaling]);

  if (!tour || !isClient) return null;

  const content = shown;
  const layout = placed && view && placed.key === view.key ? placed.layout : null;
  const bubbleLayout = placed && shown && placed.key === shown.key ? placed.layout : null;
  const veiled = Boolean(view?.target && !view.open && layout?.hole);
  const hole = veiled ? layout?.hole ?? null : null;
  const showBubble = Boolean(view && content && bubbleLayout && !bubbleOut && shown?.key === view.key);
  const tail = bubbleLayout?.tail ?? null;
  const bubbleWidth = placed?.bubbleWidth ?? BUBBLE_WIDTH;
  const number = content?.number ?? null;
  const total = content?.total ?? TOUR_TOTAL;

  function pressLink() {
    const link = content?.link;
    if (!link) return;
    const el = visibleTargets(link.target)[0];
    if (!el) return;
    if (el.getAttribute("aria-expanded") !== "true") el.click();
  }

  /** A press on the dimmed page: he looks puzzled and points back. */
  function onBlockerClick() {
    if (!settledRef.current || !dreamland || reducedMotion()) return;
    kirbyRef.current?.puzzle(PUZZLED_MS);
    lastNudge.current = 0;
    nudge();
  }

  const bubbleStyle: CSSProperties = {
    left: bubbleLayout?.bubble.left ?? 0,
    top: bubbleLayout?.bubble.top ?? 0,
    paddingLeft: bubbleLayout?.pad.left ? bubbleLayout.pad.left : undefined,
    paddingRight: bubbleLayout?.pad.right ? bubbleLayout.pad.right : undefined,
  };

  return createPortal(
    <div ref={layerRef} className="tour-layer pointer-events-none fixed inset-0 z-[60] print:hidden" hidden={!view}>
      {hole ? (
        <>
          {/* Blockers: the dimmed page swallows presses; the lit gap between them stays live. */}
          <div aria-hidden className="tour-blocker" onClick={onBlockerClick} style={{ left: 0, top: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div aria-hidden className="tour-blocker" onClick={onBlockerClick} style={{ left: 0, top: hole.bottom, right: 0, bottom: 0 }} />
          <div aria-hidden className="tour-blocker" onClick={onBlockerClick} style={{ left: 0, top: hole.top, width: Math.max(0, hole.left), height: hole.height }} />
          <div aria-hidden className="tour-blocker" onClick={onBlockerClick} style={{ left: hole.right, top: hole.top, right: 0, height: hole.height }} />
          <div
            ref={holeRef}
            aria-hidden
            className={cn("tour-hole", holeMoving && "moving")}
            style={{ left: hole.left, top: hole.top, width: hole.width, height: hole.height, borderRadius: hole.radius }}
          />
        </>
      ) : null}

      {layout?.warp && veiled && showBubble ? (
        <div aria-hidden className="tour-warp hidden dreamland:block" style={{ left: layout.warp.x, top: layout.warp.y, width: layout.warp.w }}>
          <svg
            viewBox="-40 -14 56 28"
            className="block w-full"
            style={{ transform: `${layout.warp.mirror ? "scaleX(-1) " : ""}rotate(${layout.warp.rot}deg)` }}
          >
            <g fill="none" strokeLinecap="round" strokeWidth="2.6">
              <path d="M-12 -4 Q-24 -6 -36 -10" stroke="#ff8fb4" />
              <path d="M-12 1 Q-24 1 -37 0" stroke="#ffd84a" />
              <path d="M-12 6 Q-24 8 -36 10" stroke="#7cc7f2" />
            </g>
            <path d={STAR_PATH} transform="scale(1.6)" fill="#f6c736" stroke="#d39a0c" strokeWidth=".7" strokeLinejoin="round" />
          </svg>
        </div>
      ) : null}

      <div
        ref={bubbleRef}
        role="group"
        aria-label={content?.title || LABELS.name}
        className={cn("tour-bubble pointer-events-auto", !showBubble && "out")}
        style={bubbleStyle}
      >
        {tail ? (
          <span aria-hidden className={cn("tour-tail", !tail.below && "down")} style={{ left: tail.x }} />
        ) : null}
        <span
          aria-hidden
          className="tour-name hidden dreamland:inline-flex"
          style={
            !tail
              ? { left: 24 }
              : tail.x < bubbleWidth / 2
                ? { left: tail.x + 46 }
                : { right: Math.max(24, bubbleWidth - tail.x + 22) }
          }
        >
          <Star weight="fill" aria-hidden />
          {LABELS.name}
        </span>
        <div className="tour-meta">
          {number ? (
            <>
              <span className="tour-stars" aria-hidden>
                {Array.from({ length: total }, (_, i) => (
                  <Star key={i} weight="fill" className={cn(i + 1 < number && "done", i + 1 === number && "now")} />
                ))}
              </span>
              <span>{`Step ${number} of ${total}`}</span>
            </>
          ) : null}
          {dreamland ? (
            <button
              type="button"
              className="tour-mute"
              aria-label={tour.muted ? LABELS.unmute : LABELS.mute}
              aria-pressed={tour.muted}
              onClick={tour.toggleMute}
            >
              {tour.muted ? <SpeakerSlash weight="bold" aria-hidden /> : <SpeakerHigh weight="bold" aria-hidden />}
            </button>
          ) : null}
        </div>
        {content?.title ? <p className="tour-title">{content.title}</p> : null}
        {content?.line ? <p className="tour-line">{content.line}</p> : null}
        <div className="tour-foot">
          {content?.kind === "start" ? (
            <>
              <Button type="button" size="sm" onClick={tour.start}>
                {LABELS.start}
              </Button>
              <button type="button" className="tour-alt" onClick={tour.notNow}>
                {LABELS.notNow}
              </button>
            </>
          ) : content?.kind === "finish" ? (
            <Button type="button" size="sm" onClick={tour.done}>
              {LABELS.done}
            </Button>
          ) : content?.kind === "replay" ? (
            <>
              {number && number > 1 ? (
                <Button type="button" size="sm" variant="outline" onClick={tour.back}>
                  {LABELS.back}
                </Button>
              ) : null}
              <Button type="button" size="sm" onClick={tour.next}>
                {LABELS.next}
              </Button>
              <button type="button" className="tour-skip" onClick={tour.skip}>
                {LABELS.skip}
              </button>
            </>
          ) : (
            <>
              {content?.link ? (
                <button type="button" className="tour-alt" onClick={pressLink}>
                  {content.link.label}
                </button>
              ) : null}
              <button type="button" className="tour-skip" onClick={tour.skip}>
                {LABELS.skip}
              </button>
            </>
          )}
        </div>
      </div>

      <TourKirby ref={kirbyRef} hidden={guideHidden || !dreamland} notes={tour.musicOn && dreamland && !guideHidden} />

      {/* Kirby's words are real text, announced as each step settles. */}
      <div className="sr-only" aria-live="polite">
        {showBubble && content ? [content.title, content.line].filter(Boolean).join(". ") : ""}
      </div>
    </div>,
    document.body,
  );
}
