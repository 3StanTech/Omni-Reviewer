"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp } from "@phosphor-icons/react";

import { useOptionalAsk } from "@/components/ask-provider";

export type ScrollJumpState = { show: boolean; up: boolean; down: boolean };

const HIDDEN: ScrollJumpState = { show: false, up: false, down: false };

/** Room left below the study end after Jump to end, so the last lines clear the floating controls. */
const END_CLEARANCE_PX = 96;

/**
 * Which jump buttons a page needs. Only pages taller than three screens get
 * the pair; ↑ appears once past half a screen, ↓ while the study end
 * sentinel (`endTop`, its viewport top) is still below the fold.
 */
export function scrollJumpState(input: {
  scrollY: number;
  viewport: number;
  docHeight: number;
  endTop: number | null;
}): ScrollJumpState {
  const show = input.docHeight > 3 * input.viewport;
  return {
    show,
    up: show && input.scrollY > input.viewport / 2,
    down: show && input.endTop !== null && input.endTop > input.viewport,
  };
}

function studyEnd(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-study-end]");
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

export function scrollToTop() {
  window.scrollTo({ top: 0, behavior: scrollBehavior() });
}

/** Scrolls so the study end sits near the bottom of the screen. */
export function scrollToStudyEnd() {
  const end = studyEnd();
  if (!end) return;
  const absoluteTop = end.getBoundingClientRect().top + window.scrollY;
  const top = Math.max(0, absoluteTop - window.innerHeight + END_CLEARANCE_PX);
  window.scrollTo({ top, behavior: scrollBehavior() });
}

function readState(): ScrollJumpState {
  const end = studyEnd();
  return scrollJumpState({
    scrollY: window.scrollY,
    viewport: window.innerHeight,
    docHeight: document.documentElement.scrollHeight,
    endTop: end ? end.getBoundingClientRect().top : null,
  });
}

const BUTTON_CLASS =
  "inline-flex size-11 items-center justify-center rounded-full border border-border bg-card text-foreground opacity-55 shadow-[0_6px_18px_oklch(0_0_0/25%)] transition-[opacity,background-color] duration-150 outline-none hover:bg-muted hover:opacity-100 focus-visible:bg-muted focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50";

/** Floating ↑ ↓ pair stacked above the Ask pill on long pack pages. */
export function ScrollJump() {
  const ask = useOptionalAsk();
  const [state, setState] = useState<ScrollJumpState>(HIDDEN);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = readState();
        setState((prev) =>
          prev.show === next.show && prev.up === next.up && prev.down === next.down ? prev : next,
        );
      });
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Study content loads after mount, so watch the page grow.
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // The open Ask panel covers this corner.
  if (ask?.isOpen) return null;
  if (!state.show) return null;

  return (
    <div className="print-hide fixed right-4 bottom-[calc(max(1rem,env(safe-area-inset-bottom))_+_3.25rem)] z-30 flex flex-col gap-2 max-[640px]:right-3 max-[640px]:bottom-[calc(max(6rem,calc(env(safe-area-inset-bottom)_+_5rem))_+_3.25rem)]">
      {state.up ? (
        <button
          type="button"
          aria-label="Back to top"
          title="Back to top"
          className={BUTTON_CLASS}
          onMouseDown={(event) => event.preventDefault()}
          onClick={scrollToTop}
        >
          <ArrowUp weight="bold" className="size-[1.125rem]" aria-hidden />
        </button>
      ) : null}
      {state.down ? (
        <button
          type="button"
          aria-label="Jump to end"
          title="Jump to end"
          className={BUTTON_CLASS}
          onMouseDown={(event) => event.preventDefault()}
          onClick={scrollToStudyEnd}
        >
          <ArrowDown weight="bold" className="size-[1.125rem]" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
