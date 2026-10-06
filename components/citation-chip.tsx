"use client";

import type { ReactNode } from "react";

import { useSourceViewer } from "@/components/source-modal";
import { lastSentence } from "@/lib/passage-tint";
import { cn } from "@/lib/utils";

type CitationChipProps = {
  source: number;
  pageStart: number | null;
  pageEnd: number | null;
  /** Inside another control (a Test Me choice), render inert text, never a nested button. */
  inert?: boolean;
  children?: ReactNode;
};

const CHIP_CLASS =
  "study-cite mx-0.5 inline-block rounded-[5px] bg-primary/15 px-1.5 align-[1px] font-mono text-[0.72em] leading-[1.5] font-normal whitespace-nowrap text-primary no-underline select-none";

export function citationAriaLabel(source: number, pageStart: number | null, pageEnd: number | null): string {
  if (pageStart === null) return `Open source ${source}`;
  if (pageEnd !== null && pageEnd !== pageStart) return `Open source pages ${pageStart} to ${pageEnd}`;
  return `Open source page ${pageStart}`;
}

/**
 * The sentence a chip cites: the last sentence of its block's text before the
 * chip, without other chips or unsourced tags. A table cell reads its whole row.
 */
function claimTextForChip(chip: HTMLElement): string | null {
  const block = chip.closest("li, p, td, th, blockquote");
  if (!block) return null;
  const container = block.matches("td, th") ? block.closest("tr") ?? block : block;
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEndBefore(chip);
  const before = range.cloneContents();
  before.querySelectorAll("[data-study-skip]").forEach((skipped) => skipped.remove());
  before.querySelectorAll("td, th").forEach((cell) => cell.append(" "));
  return lastSentence(before.textContent ?? "");
}

/**
 * A `[S1 p.14]` citation. Marked `data-study-skip` so the annotation text model
 * never counts the chip label.
 */
export function CitationChip({ source, pageStart, pageEnd, inert = false, children }: CitationChipProps) {
  const { openSource, available } = useSourceViewer();
  if (inert || !available) {
    return (
      <span data-study-skip="" className={cn(CHIP_CLASS, "opacity-80")}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-study-skip=""
      aria-label={citationAriaLabel(source, pageStart, pageEnd)}
      className={cn(
        CHIP_CLASS,
        "relative cursor-pointer transition-colors duration-150 outline-none hover:bg-primary hover:text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        // Reach 44px on touch without changing the inline line box.
        "pointer-coarse:before:absolute pointer-coarse:before:inset-x-[-4px] pointer-coarse:before:inset-y-[-13px] pointer-coarse:before:content-['']",
      )}
      onClick={(event) => {
        // Carded fronts flip on click; a citation opens the source instead.
        event.stopPropagation();
        openSource({ source, page: pageStart, pageEnd, claim: claimTextForChip(event.currentTarget) });
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      {children}
    </button>
  );
}
