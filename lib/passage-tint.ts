/**
 * Pure helpers for tinting a cited passage in the source viewer: the claim a
 * chip points at, PDF.js text item offsets and boxes, and range page choice.
 */

import { isSentenceAbbreviation } from "@/lib/citations";

/** D7: soft and discreet. The PDF canvas stays white in dark mode, so its tint is fixed. */
export const PASSAGE_TINT_CLASS = {
  canvasBox: "absolute rounded-sm bg-primary/20",
  textMark: "rounded-sm bg-primary/15 text-foreground",
} as const;

/** A range citation scores at most this many pages. */
export const RANGE_TINT_MAX_PAGES = 4;

/** The last sentence of the text before a chip, or null when nothing is left. */
export function lastSentence(textBefore: string): string | null {
  const text = textBefore.replace(/\s+/g, " ").trim();
  let from = 0;
  for (const match of text.matchAll(/[.!?](?=\s)/g)) {
    if (match[0] === "." && isSentenceAbbreviation(text, match.index)) continue;
    from = match.index + 1;
  }
  const sentence = text.slice(from).trim();
  return sentence || null;
}

/** The structural part of a PDF.js text item (marked-content items, which have no `str`, are filtered out first). */
export type TintTextItem = { str: string; hasEOL?: boolean; transform?: number[]; width?: number };

export type JoinedTextItems = { text: string; ranges: Array<{ start: number; end: number }> };

/** One string from text items (`" "` between items, `"\n"` after an end of line) with each item's [start, end). */
export function joinTextItems(items: ReadonlyArray<TintTextItem>): JoinedTextItems {
  let text = "";
  const ranges: JoinedTextItems["ranges"] = [];
  for (const item of items) {
    const start = text.length;
    text += item.str;
    ranges.push({ start, end: text.length });
    text += item.hasEOL ? "\n" : " ";
  }
  return { text, ranges };
}

/** Indexes of the items whose text overlaps [span.start, span.end). */
export function itemsInSpan(
  ranges: JoinedTextItems["ranges"],
  span: { start: number; end: number },
): number[] {
  const indexes: number[] = [];
  ranges.forEach((range, index) => {
    if (range.end > range.start && range.start < span.end && range.end > span.start) indexes.push(index);
  });
  return indexes;
}

/** `m1 x m2` for PDF 2D affine matrices `[a, b, c, d, e, f]`, as PDF.js `Util.transform`. */
export function multiplyTransform(m1: ReadonlyArray<number>, m2: ReadonlyArray<number>): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export type TintBox = { left: number; top: number; width: number; height: number };

/** CSS pixel box of one text item on a page drawn with `viewportTransform` at `scale`. */
export function textItemBox(
  viewportTransform: ReadonlyArray<number>,
  scale: number,
  item: TintTextItem,
): TintBox | null {
  if (!item.transform || typeof item.width !== "number") return null;
  const [, , c, d, e, f] = multiplyTransform(viewportTransform, item.transform);
  const height = Math.hypot(c, d);
  const width = item.width * scale;
  if (!(height > 0) || !(width > 0)) return null;
  return { left: e, top: f - height, width, height };
}

/** Pages a range citation scores: `page` through `pageEnd`, capped at RANGE_TINT_MAX_PAGES. */
export function rangeTintPages(page: number, pageEnd: number | null | undefined): number[] {
  if (!pageEnd || pageEnd <= page) return [page];
  const last = Math.min(pageEnd, page + RANGE_TINT_MAX_PAGES - 1);
  const pages: number[] = [];
  for (let current = page; current <= last; current++) pages.push(current);
  return pages;
}

/** The page with the highest score; ties go to the first. Null when no page scored. */
export function bestScoredPage(scores: ReadonlyArray<{ page: number; score: number | null }>): number | null {
  let best: { page: number; score: number } | null = null;
  for (const entry of scores) {
    if (entry.score === null) continue;
    if (!best || entry.score > best.score) best = { page: entry.page, score: entry.score };
  }
  return best?.page ?? null;
}
