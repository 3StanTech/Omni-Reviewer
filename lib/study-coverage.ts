/**
 * Section coverage by cited pages. A "## " section's pages are the pages cited
 * inside it; an item covers the section when its text cites one of them.
 * Sections that cite no page cannot be measured and are never reported.
 */

import { parseCitations } from "@/lib/citations";
import { splitSections } from "@/lib/study-sections";

/** Same cap as `citedPageCount`, so a malformed huge range cannot blow up a set. */
const MAX_PAGES_PER_CITED_RANGE = 50;

/** Cited pages with ranges expanded, as source and page. Whole-source citations add nothing. */
function citedPages(text: string): Array<{ source: number; page: number }> {
  const pages: Array<{ source: number; page: number }> = [];
  for (const citation of parseCitations(text)) {
    if (citation.pageStart === null || !Number.isFinite(citation.pageStart)) continue;
    const end = Math.min(citation.pageEnd ?? citation.pageStart, citation.pageStart + MAX_PAGES_PER_CITED_RANGE - 1);
    for (let page = citation.pageStart; page <= end; page++) pages.push({ source: citation.source, page });
  }
  return pages;
}

/** "source:page" keys, so the same page number in two sources stays distinct. */
function pageKeys(text: string): Set<string> {
  return new Set(citedPages(text).map(({ source, page }) => `${source}:${page}`));
}

/** Page numbers cited in the text, with ranges expanded. Whole-source citations add nothing. */
export function itemPages(text: string): Set<number> {
  return new Set(citedPages(text).map(({ page }) => page));
}

/** Every "## " section with the pages cited inside it (possibly none). */
export function sectionPages(markdown: string): Array<{ heading: string; markdown: string; pages: Set<number> }> {
  return splitSections(markdown).sections.map((section) => ({
    heading: section.heading,
    markdown: section.markdown,
    pages: itemPages(section.markdown),
  }));
}

/**
 * Sections, in document order, that cite at least one page and share no page
 * with any item. Sections without page citations are never returned.
 */
export function uncoveredSections<T>(
  markdown: string,
  items: readonly T[],
  textOf: (item: T) => string,
): Array<{ heading: string; markdown: string }> {
  const covered = new Set<string>();
  for (const item of items) {
    for (const key of pageKeys(textOf(item))) covered.add(key);
  }
  return splitSections(markdown).sections
    .filter((section) => {
      const keys = [...pageKeys(section.markdown)];
      return keys.length > 0 && !keys.some((key) => covered.has(key));
    })
    .map(({ heading, markdown: sectionMarkdown }) => ({ heading, markdown: sectionMarkdown }));
}
