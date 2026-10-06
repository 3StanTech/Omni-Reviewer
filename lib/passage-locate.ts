/**
 * Finds the span of a source page that best supports a study claim, scored
 * with grounding's lexical scorer. Pure and client-safe, for tinting the
 * supporting passage in the source viewer.
 */

import { stripCitations } from "@/lib/citations";
import { passageScorer } from "@/lib/grounding";

/** Tuned on the bench transcripts: cited claims score about 0.9; other pages rarely reach 0.5. */
export const PASSAGE_TINT_MIN_SCORE = 0.5;

export type LocatedPassage = { start: number; end: number; score: number };

const MIN_WINDOW_CHARS = 120;
const MAX_WINDOW_CHARS = 400;
const BOUNDARY = /[.!?]\s|\n/g;

/** Windows of `size` characters, half a window apart; the last one ends at the text end. */
function windowStarts(length: number, size: number): number[] {
  if (length <= size) return [0];
  const step = Math.max(1, Math.floor(size / 2));
  const starts: number[] = [];
  for (let start = 0; start + size < length; start += step) starts.push(start);
  starts.push(length - size);
  return starts;
}

/** Narrows [start, end) to sentence or line boundaries inside its first and last thirds, then trims whitespace. */
function trimToBoundaries(text: string, start: number, end: number): { start: number; end: number } {
  const window = text.slice(start, end);
  const third = Math.floor(window.length / 3);
  let from: number | null = null;
  let to = window.length;
  for (const match of window.matchAll(BOUNDARY)) {
    const index = match.index;
    if (from === null && index < third) from = index + match[0].length;
    // A sentence end keeps its punctuation; a line end stops before the newline.
    if (index >= window.length - third) to = match[0] === "\n" ? index : index + 1;
  }
  from ??= 0;
  let trimmedStart = start + from;
  let trimmedEnd = start + to;
  while (trimmedStart < trimmedEnd && /\s/.test(text[trimmedStart])) trimmedStart++;
  while (trimmedEnd > trimmedStart && /\s/.test(text[trimmedEnd - 1])) trimmedEnd--;
  if (trimmedStart < trimmedEnd) return { start: trimmedStart, end: trimmedEnd };
  return { start, end };
}

/** The span of `text` that best supports `claim`, or null when nothing scores at least `minScore`. */
export function locatePassage(claim: string, text: string, options?: { minScore?: number }): LocatedPassage | null {
  const stripped = stripCitations(claim).replace(/\s+/g, " ").trim();
  if (!stripped || !text.trim()) return null;

  const size = Math.min(
    text.length,
    Math.min(MAX_WINDOW_CHARS, Math.max(MIN_WINDOW_CHARS, Math.round(stripped.length * 1.5))),
  );
  const score = passageScorer(stripped);
  let best = { start: 0, score: -1 };
  for (const start of windowStarts(text.length, size)) {
    const windowScore = score(text.slice(start, start + size));
    if (windowScore > best.score) best = { start, score: windowScore };
  }
  if (best.score < (options?.minScore ?? PASSAGE_TINT_MIN_SCORE)) return null;

  return { ...trimToBoundaries(text, best.start, best.start + size), score: best.score };
}
