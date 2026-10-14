"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowDown, ArrowUp, CaretDown, NotePencil } from "@phosphor-icons/react";

import { useOptionalAsk } from "@/components/ask-provider";
import { RAIL_HEADER_CLASS } from "@/components/mode-toolbar";
import { scrollToStudyEnd, scrollToTop } from "@/components/scroll-jump";
import { ContentsList, NotesList, useSectionMastery } from "@/components/study-side-panel";
import { buttonVariants } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import type { AnnotationRecord } from "@/lib/annotations";
import { currentHeadingIndex, readingProgress } from "@/lib/reading-position";
import { STUDY_HEADING_CLOBBER_PREFIX, studyOutline, type StudyHeading } from "@/lib/study-outline";
import { cn } from "@/lib/utils";

export type ReadingPositionState = { currentId: string | null; progress: number };

/** A heading counts as current once its top passes this share of the viewport. */
const CURRENT_HEADING_LINE = 0.3;

/**
 * The section being read and how far through the document the reader is.
 * Measures on scroll (once per frame), on resize and when the article resizes.
 */
export function useReadingPosition({ headings, articleRef }: { headings: StudyHeading[]; articleRef: RefObject<HTMLElement | null> }): ReadingPositionState {
  const [position, setPosition] = useState<ReadingPositionState>({ currentId: null, progress: 0 });

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      const viewport = window.innerHeight;
      const tops: number[] = [];
      const ids: string[] = [];
      for (const heading of headings) {
        const element = document.getElementById(STUDY_HEADING_CLOBBER_PREFIX + heading.id);
        if (!element) continue;
        tops.push(element.getBoundingClientRect().top);
        ids.push(heading.id);
      }
      const index = currentHeadingIndex(tops, viewport * CURRENT_HEADING_LINE);
      const start = article.getBoundingClientRect().top;
      const end = document.querySelector("[data-study-end]")?.getBoundingClientRect().top ?? article.getBoundingClientRect().bottom;
      const next = { currentId: index >= 0 ? ids[index] : null, progress: readingProgress({ start, end, viewport }) };
      setPosition((current) => (current.currentId === next.currentId && current.progress === next.progress ? current : next));
    };
    const schedule = () => {
      if (frame === undefined) frame = window.requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(article);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [articleRef, headings]);

  return position;
}

/** After the reader scrolls the rail, it stops following the current section for this long. */
const RAIL_FOLLOW_PAUSE_MS = 2000;
/** Room left above or below the current item when the rail scrolls to it. */
const RAIL_FOLLOW_MARGIN = 8;

/** The nearest ancestor that scrolls vertically (the rail's sticky inner), or null. */
function scrollContainerOf(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = window.getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
}

/**
 * Keeps the current Contents item visible inside the rail's own scroll
 * container (nearest-edge scrolling, never the window). Pauses while the
 * reader has scrolled the rail in the last two seconds.
 */
function useRailFollow(navRef: RefObject<HTMLElement | null>, currentId: string | null) {
  const lastReaderScroll = useRef(0);

  useEffect(() => {
    const nav = navRef.current;
    const container = nav ? scrollContainerOf(nav) : null;
    if (!container) return;
    const mark = () => {
      lastReaderScroll.current = Date.now();
    };
    container.addEventListener("wheel", mark, { passive: true });
    container.addEventListener("pointerdown", mark);
    container.addEventListener("touchstart", mark, { passive: true });
    return () => {
      container.removeEventListener("wheel", mark);
      container.removeEventListener("pointerdown", mark);
      container.removeEventListener("touchstart", mark);
    };
  }, [navRef]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !currentId) return;
    if (Date.now() - lastReaderScroll.current < RAIL_FOLLOW_PAUSE_MS) return;
    const container = scrollContainerOf(nav);
    const link = nav.querySelector<HTMLElement>('[aria-current="location"]');
    if (!container || !link) return;
    const box = container.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    let delta = 0;
    if (item.top < box.top + RAIL_FOLLOW_MARGIN) delta = item.top - box.top - RAIL_FOLLOW_MARGIN;
    else if (item.bottom > box.bottom - RAIL_FOLLOW_MARGIN) delta = item.bottom - box.bottom + RAIL_FOLLOW_MARGIN;
    if (delta === 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({ top: container.scrollTop + delta, behavior: reduce ? "auto" : "smooth" });
  }, [navRef, currentId]);
}

const RAIL_BUTTON_CLASS = cn(buttonVariants({ variant: "ghost", size: "sm" }), "min-h-9 w-full justify-start");

type StudyRailProps = {
  markdown: string;
  annotations: AnnotationRecord[];
  articleRef: RefObject<HTMLElement | null>;
};

/** Locked In and Summary rail: Contents with the current section and progress, Top and End, then Notes. */
export function StudyRail({ markdown, annotations, articleRef }: StudyRailProps) {
  const headings = useMemo(() => studyOutline(markdown).filter((heading) => heading.level <= 3), [markdown]);
  const { currentId, progress } = useReadingPosition({ headings, articleRef });
  return <StudyRailBody headings={headings} annotations={annotations} currentId={currentId} progress={progress} />;
}

/** The rail's markup, separate from the scroll tracking so it renders without a document. */
export function StudyRailBody({ headings, annotations, currentId, progress }: { headings: StudyHeading[]; annotations: AnnotationRecord[]; currentId: string | null; progress: number }) {
  const sections = useSectionMastery();
  const savedAnswerCount = useOptionalAsk()?.savedCount ?? 0;
  const noteCount = annotations.filter((annotation) => !annotation.archivedAt).length + savedAnswerCount;
  const navRef = useRef<HTMLElement>(null);
  useRailFollow(navRef, currentId);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <Panel aria-label="Contents" className="bg-rail">
        <PanelHeader
          label="Contents"
          className={RAIL_HEADER_CLASS}
          actions={<span className="text-xs tabular-nums" aria-label={`Read ${progress} percent`}>{progress}%</span>}
        />
        <div className="space-y-1 p-2">
          <button type="button" className={RAIL_BUTTON_CLASS} onClick={scrollToTop}>
            <ArrowUp weight="bold" aria-hidden />
            Top
          </button>
          <nav ref={navRef} aria-label="Document contents" className="px-2.5 py-1">
            <ContentsList headings={headings} sections={sections} currentId={currentId} />
          </nav>
          <button type="button" className={RAIL_BUTTON_CLASS} onClick={scrollToStudyEnd}>
            <ArrowDown weight="bold" aria-hidden />
            End
          </button>
        </div>
        <div className="space-y-1.5 border-t border-divider px-4 pt-2.5 pb-3 text-xs text-muted-foreground">
          <p>Reading progress {progress}%</p>
          <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-divider">
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </Panel>
      <Panel as="details" className="group bg-rail">
        {/* The summary is the panel's header band; the caret comes last visually. */}
        <summary
          className={cn(
            "flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-[calc(var(--radius)-1px)] px-4 py-2.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 group-open:rounded-b-none group-open:border-b group-open:border-divider [&::-webkit-details-marker]:hidden",
            RAIL_HEADER_CLASS,
          )}
        >
          <CaretDown weight="bold" aria-hidden className="order-last ml-auto group-open:rotate-180" />
          <NotePencil weight="bold" aria-hidden />
          Notes ({noteCount})
        </summary>
        <div className="px-4 pb-3">
          <NotesList annotations={annotations} />
        </div>
      </Panel>
    </div>
  );
}
