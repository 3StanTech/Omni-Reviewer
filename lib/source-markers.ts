/**
 * Page and slide boundaries inside stored source text.
 *
 * Extraction writes one marker line before every page (PDF) or slide (PPTX) so
 * prompts, citations, grounding, and the source viewer can all agree on page
 * numbers. Sources without pages (DOCX, pasted text, images) carry no markers
 * and are cited as a whole source.
 *
 * Inside a page, a `<<<slide image>>>` line starts text that was read from the
 * page's picture by the vision model. It stays in prompts and grounding, and is
 * stripped for display and export.
 */

const MARKER_SOURCE = String.raw`^<<<page (\d{1,4})>>>$`;

export const SLIDE_IMAGE_MARKER = "<<<slide image>>>";

/** Written when a slide was read but holds nothing to study, so it is never re-read. */
export const NO_READABLE_CONTENT = "(no readable content)";

const SLIDE_IMAGE_SOURCE = String.raw`^<<<slide image>>>$`;
const NO_READABLE_CONTENT_SOURCE = String.raw`^\(no readable content\)$`;

/**
 * A fresh pattern per use: a shared global RegExp keeps lastIndex after
 * test(), and matchAll() copies it, which silently skipped page 1.
 */
function markerLine(): RegExp {
  return new RegExp(MARKER_SOURCE, "gm");
}

function slideImageLine(): RegExp {
  return new RegExp(SLIDE_IMAGE_SOURCE, "gm");
}

export function pageMarker(page: number): string {
  return `<<<page ${page}>>>`;
}

/** Join per-page text with a marker before each page, numbering from 1. */
export function joinPages(pages: readonly string[]): string {
  return pages
    .map((text, index) => `${pageMarker(index + 1)}\n\n${text.trim()}`)
    .join("\n\n");
}

/** Characters `joinPages` adds around the page texts, for extraction budgets. */
export function pageMarkerOverhead(page: number, isFirst: boolean): number {
  return pageMarker(page).length + 2 + (isFirst ? 0 : 2);
}

export function hasPageMarkers(text: string | null | undefined): boolean {
  if (!text) return false;
  return markerLine().test(text);
}

export type SourcePage = { page: number; text: string };

/**
 * Split stored text into pages. Text without markers is a single page 0, which
 * callers treat as "the whole source".
 */
export function splitPages(text: string): SourcePage[] {
  const matches = [...text.matchAll(markerLine())];
  if (matches.length === 0) return [{ page: 0, text: text.trim() }];

  const pages: SourcePage[] = [];
  const leading = text.slice(0, matches[0].index).trim();
  if (leading) pages.push({ page: 0, text: leading });
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    pages.push({ page: Number(match[1]), text: text.slice(start, end).trim() });
  });
  return pages;
}

/** Text of one page, or null when the page does not exist. */
export function pageText(text: string, page: number): string | null {
  return splitPages(text).find((entry) => entry.page === page)?.text ?? null;
}

/** Highest page number, or 0 when the text has no markers. */
export function pageCount(text: string): number {
  return splitPages(text).reduce((max, entry) => Math.max(max, entry.page), 0);
}

/** Remove page and slide-image marker lines for display or export. */
export function stripPageMarkers(text: string): string {
  return text
    .replace(markerLine(), "")
    .replace(slideImageLine(), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A page's extracted text, without any block read from its picture. */
export function pageBaseText(pageText: string): string {
  const match = slideImageLine().exec(pageText);
  return (match ? pageText.slice(0, match.index) : pageText).trim();
}

/** True once a page carries a slide-image block, including the empty placeholder. */
export function pageHasSlideImageText(pageText: string): boolean {
  return slideImageLine().test(pageText);
}

/**
 * Append (or replace) the slide-image block of one page. Marker lines inside
 * the vision text are dropped so a reading can never forge a page boundary.
 */
export function withSlideImageText(pageText: string, visionText: string): string {
  const base = pageBaseText(pageText);
  const reading = stripPageMarkers(visionText) || NO_READABLE_CONTENT;
  const block = `${SLIDE_IMAGE_MARKER}\n${reading}`;
  return base ? `${base}\n\n${block}` : block;
}

/**
 * True when the text holds something to study: markers alone, or slides read
 * as having no readable content, do not count.
 */
export function hasMeaningfulText(text: string | null | undefined): boolean {
  if (!text) return false;
  return stripPageMarkers(text)
    .replace(new RegExp(NO_READABLE_CONTENT_SOURCE, "gm"), "")
    .trim().length > 0;
}
