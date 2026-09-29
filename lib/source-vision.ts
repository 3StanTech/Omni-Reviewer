import "server-only";

import { MAX_EXTRACTED_TEXT_CHARS } from "@/lib/ingest";
import { PublicError } from "@/lib/public-errors";
import {
  pageBaseText,
  pageHasSlideImageText,
  pageMarker,
  splitPages,
  withSlideImageText,
} from "@/lib/source-markers";

/**
 * Reading slide pictures for PDF pages that carry little text. The browser
 * renders pending pages to JPEG; the server only sends them to the vision
 * model and merges each reading into that page's text after a
 * `<<<slide image>>>` line, so page citations keep working.
 */

/** A page whose extracted text is shorter than this is read from its picture. */
export const LOW_TEXT_PAGE_CHARS = 200;
export const MAX_VISION_BATCH_PAGES = 8;
/** Kept under Vercel's 4.5 MB request body limit with room for form overhead. */
export const MAX_VISION_IMAGE_BYTES = 800 * 1024;
export const MAX_VISION_BATCH_BYTES = 4 * 1024 * 1024;
export const MAX_VISION_PAGE_CHARS = 8_000;

export const VISION_PAGES_INSTRUCTION = [
  "You are reading lecture slides for a student's study notes. Each image is preceded by a label such as \"Slide 12:\".",
  "For every slide:",
  "- Transcribe all visible text, keeping headings, lists and labels.",
  "- Write equations in LaTeX.",
  "- Describe each figure, graph, diagram and table in study terms: axes, trends, labelled parts, and what it shows.",
  "- Prefix handwritten annotations with \"Handwritten note:\".",
  "- Ignore projector glare, the room and people.",
  "- Never add facts that are not visible on the slide.",
  "Output the slides in the given order. Start each slide with a line <<<page N>>>, where N is the number from that slide's label, then write its reading.",
  "If a slide has nothing educational, write (no readable content) as its reading.",
].join("\n");

/** Pages (1 and up) that have little text and have not been read yet. */
export function pendingVisionPages(text: string): number[] {
  return splitPages(text)
    .filter((entry) =>
      entry.page >= 1
      && !pageHasSlideImageText(entry.text)
      && pageBaseText(entry.text).length < LOW_TEXT_PAGE_CHARS)
    .map((entry) => entry.page);
}

export type VisionPageSummary = { pending: number[]; pageTotal: number; readCount: number };

export function visionPageSummary(text: string): VisionPageSummary {
  const pages = splitPages(text).filter((entry) => entry.page >= 1);
  return {
    pending: pendingVisionPages(text),
    pageTotal: pages.reduce((max, entry) => Math.max(max, entry.page), 0),
    readCount: pages.filter((entry) => pageHasSlideImageText(entry.text)).length,
  };
}

type SlideLabel = { page: number; title: string };

/**
 * A whole line that only labels a slide, as the model echoes our "Slide N:"
 * image labels: `### Slide 15:`, `**Slide 9:**`, `Slide 4`. A title after the
 * colon (`### Slide 25: Example 5`) is accepted only on a heading or emphasis
 * line, so a plain sentence that starts with "Slide 3:" is never split.
 * Mentions inside a line, such as "(Slide 6)", never match.
 */
function slideLabel(line: string): SlideLabel | null {
  const match = new RegExp(
    "^([ \\t#*_>]*)slide[ \\t]+(\\d{1,4})[ \\t]*(?::[ \\t]*(.*?))?[ \\t*_]*$",
    "i",
  ).exec(line);
  if (!match) return null;
  const title = (match[3] ?? "").trim();
  if (title && !/[#*_>]/.test(match[1]!)) return null;
  return { page: Number(match[2]), title };
}

/**
 * Free models often ignore the requested page lines: they bold or pad them,
 * or echo the image labels as headings instead. Rewrite a whole-line page
 * marker or slide label to the canonical `<<<page N>>>` form, keep a label's
 * title as the page's first line, and drop a label that only repeats the
 * marker right above it.
 */
function normalizeVisionMarkers(output: string): string {
  const out: string[] = [];
  // The page whose marker was just written, until a content line follows.
  let openPage: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    const marker = new RegExp(
      "^[ \\t*_#>`]*<<<[ \\t]*page[ \\t]+(\\d{1,4})[ \\t]*>>>[ \\t*_`]*$",
      "i",
    ).exec(line);
    if (marker) {
      openPage = Number(marker[1]);
      out.push(pageMarker(openPage));
      continue;
    }
    const label = slideLabel(line);
    if (label) {
      if (openPage !== label.page) out.push(pageMarker(label.page));
      if (label.title) out.push(label.title);
      openPage = label.title ? null : label.page;
      continue;
    }
    out.push(line);
    if (line.trim()) openPage = null;
  }
  return out.join("\n");
}

/**
 * Readings per requested page. Text before the first marker, unrequested
 * pages, and empty readings are dropped; the first non-empty reading of a
 * repeated page wins. An absent page is "missing" to the caller.
 */
export function parseVisionBatch(
  output: string,
  requestedPages: readonly number[],
): Map<number, string> {
  const requested = new Set(requestedPages);
  const readings = new Map<number, string>();
  for (const entry of splitPages(normalizeVisionMarkers(output))) {
    if (entry.page < 1 || !requested.has(entry.page) || readings.has(entry.page)) continue;
    const reading = entry.text.trim().slice(0, MAX_VISION_PAGE_CHARS).trim();
    if (reading) readings.set(entry.page, reading);
  }
  return readings;
}

/**
 * Rebuild the source text with each reading merged into its page. Page
 * numbers, order, and untouched page text are kept exactly; a leading page 0
 * stays in front. An empty reading writes the "(no readable content)" block.
 */
export function mergeVisionPages(text: string, readings: ReadonlyMap<number, string>): string {
  const merged = splitPages(text)
    .map((entry) => {
      if (entry.page === 0) return entry.text;
      const reading = readings.get(entry.page);
      const body = reading === undefined ? entry.text : withSlideImageText(entry.text, reading);
      return `${pageMarker(entry.page)}\n\n${body}`;
    })
    .join("\n\n")
    .trim();
  if (merged.length > MAX_EXTRACTED_TEXT_CHARS) {
    throw new PublicError(
      `Slide readings would exceed the ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()} character limit`,
    );
  }
  return merged;
}
