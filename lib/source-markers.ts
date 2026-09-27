/**
 * Page and slide boundaries inside stored source text.
 *
 * Extraction writes one marker line before every page (PDF) or slide (PPTX) so
 * prompts, citations, grounding, and the source viewer can all agree on page
 * numbers. Sources without pages (DOCX, pasted text, images) carry no markers
 * and are cited as a whole source.
 */

const MARKER_LINE = /^<<<page (\d{1,4})>>>$/gm;

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
  MARKER_LINE.lastIndex = 0;
  return MARKER_LINE.test(text);
}

export type SourcePage = { page: number; text: string };

/**
 * Split stored text into pages. Text without markers is a single page 0, which
 * callers treat as "the whole source".
 */
export function splitPages(text: string): SourcePage[] {
  const matches = [...text.matchAll(MARKER_LINE)];
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

/** Remove marker lines for display or export. */
export function stripPageMarkers(text: string): string {
  return text.replace(MARKER_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}
