import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";

import { remarkDropStudyFootnotes } from "@/lib/annotations";
import { parseCitations, stripCitations } from "@/lib/citations";
import { studyOutline } from "@/lib/study-outline";

/**
 * Section mastery, computed on read from existing rows (no schema).
 *
 * A section is a heading of the current Locked In. A Test Me item or a card
 * belongs to every section that cites one of the same pages as the item's own
 * citations (Test Me explanation, card back). Evidence is the latest attempt
 * per current Test Me item and the latest review per live card.
 */

/** A section under this score (0 to 1) is weak. */
export const MASTERY_WEAK_THRESHOLD = 0.6;
/** A section with fewer evidence items than this has no score yet. */
export const MASTERY_MIN_ITEMS = 3;

const WHOLE_SOURCE = "*";

/**
 * Page keys cited in `text`: "S1:14" for a page (ranges expand), "S2:*" for a
 * bare whole-source citation such as `[S2]`. Uses the shared citation grammar.
 */
export function citedPages(text: string): Set<string> {
  const pages = new Set<string>();
  for (const citation of parseCitations(text)) {
    if (citation.pageStart === null) {
      pages.add(`S${citation.source}:${WHOLE_SOURCE}`);
      continue;
    }
    const end = citation.pageEnd ?? citation.pageStart;
    for (let page = citation.pageStart; page <= end; page += 1) pages.add(`S${citation.source}:${page}`);
  }
  return pages;
}

export type MasterySection = {
  /** The id `lib/study-outline.ts` gives this heading, so bars line up with Contents. */
  id: string;
  title: string;
  level: number;
  pages: Set<string>;
  /** Words in the section body, citations excluded. */
  words: number;
};

type PositionedNode = {
  type: string;
  depth?: number;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkDropStudyFootnotes).use(remarkMath);

function wordCount(text: string): number {
  return stripCitations(text)
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Which heading level defines sections: `##`, else `#` or `###` with 2 or more (more headings wins, then `#`). */
function sectionLevel(levels: number[]): number | null {
  const count = (level: number) => levels.filter((value) => value === level).length;
  if (count(2) >= 2) return 2;
  const candidates = [1, 3].filter((level) => count(level) >= 2);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, level) => (count(level) > count(best) ? level : best));
}

export function sectionsFromLockedIn(markdown: string): MasterySection[] {
  const source = markdown.replace(/\r\n?/g, "\n");
  const outline = studyOutline(source);
  if (outline.length === 0) return [];

  let nodes: PositionedNode[];
  try {
    const tree = markdownParser.runSync(markdownParser.parse(source)) as unknown as { children?: PositionedNode[] };
    nodes = (tree.children ?? []).filter((node) => node.type === "heading");
  } catch {
    return [];
  }
  // The outline and this parse read the same top-level headings in order.
  if (nodes.length !== outline.length) return [];

  const level = sectionLevel(outline.map((heading) => heading.level));
  if (level === null) return [];

  const sections: MasterySection[] = [];
  for (let index = 0; index < outline.length; index += 1) {
    const heading = outline[index];
    if (heading.level !== level) continue;
    const start = nodes[index].position?.end.offset ?? 0;
    let end = source.length;
    for (let next = index + 1; next < outline.length; next += 1) {
      if (outline[next].level <= level) {
        end = nodes[next].position?.start.offset ?? end;
        break;
      }
    }
    const body = source.slice(start, end);
    sections.push({ id: heading.id, title: heading.text, level, pages: citedPages(body), words: wordCount(body) });
  }
  return sections;
}

/** Item pages match section pages on the same page, or when either side cites its whole source. */
function pagesOverlap(item: Set<string>, section: Set<string>): boolean {
  for (const itemKey of item) {
    if (section.has(itemKey)) return true;
    const [source, page] = itemKey.split(":");
    if (page === WHOLE_SOURCE) {
      for (const sectionKey of section) if (sectionKey.startsWith(`${source}:`)) return true;
    } else if (section.has(`${source}:${WHOLE_SOURCE}`)) {
      return true;
    }
  }
  return false;
}

export type MasteryInput = {
  lockedIn: string | null;
  testItems: { id: string; explanation: string }[];
  attempts: { itemId: string; correct: boolean; attemptedAt: Date }[];
  cards: { id: string; back: string; archivedAt: Date | null }[];
  cardReviews: { cardId: string; rating: "again" | "good"; reviewedAt: Date }[];
};

export type SectionMastery = { id: string; title: string; score: number | null; items: number; weak: boolean };

export type MasteryResult = {
  pack: { score: number | null; items: number };
  sections: SectionMastery[];
  weakest: { id: string; title: string; score: number } | null;
};

/** The newest row per key; on equal times the later row wins. */
function latestBy<T>(rows: T[], key: (row: T) => string, time: (row: T) => number): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const current = latest.get(key(row));
    if (!current || time(row) >= time(current)) latest.set(key(row), row);
  }
  return latest;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeMastery(input: MasteryInput): MasteryResult {
  const evidence: { pages: Set<string>; value: number }[] = [];

  const explanations = new Map(input.testItems.map((item) => [item.id, item.explanation]));
  const latestAttempts = latestBy(
    input.attempts.filter((attempt) => explanations.has(attempt.itemId)),
    (attempt) => attempt.itemId,
    (attempt) => attempt.attemptedAt.getTime(),
  );
  for (const [itemId, attempt] of latestAttempts) {
    evidence.push({ pages: citedPages(explanations.get(itemId) ?? ""), value: attempt.correct ? 1 : 0 });
  }

  const liveCards = new Map(input.cards.filter((card) => card.archivedAt === null).map((card) => [card.id, card.back]));
  const latestReviews = latestBy(
    input.cardReviews.filter((review) => liveCards.has(review.cardId)),
    (review) => review.cardId,
    (review) => review.reviewedAt.getTime(),
  );
  for (const [cardId, review] of latestReviews) {
    evidence.push({ pages: citedPages(liveCards.get(cardId) ?? ""), value: review.rating === "good" ? 1 : 0 });
  }

  const sections: SectionMastery[] = sectionsFromLockedIn(input.lockedIn ?? "").map((section) => {
    const values = evidence.filter((item) => pagesOverlap(item.pages, section.pages)).map((item) => item.value);
    const score = values.length >= MASTERY_MIN_ITEMS ? mean(values) : null;
    return {
      id: section.id,
      title: section.title,
      score,
      items: values.length,
      weak: score !== null && score < MASTERY_WEAK_THRESHOLD,
    };
  });

  let weakest: MasteryResult["weakest"] = null;
  let weakestItems = 0;
  for (const section of sections) {
    if (section.score === null) continue;
    if (weakest === null || section.score < weakest.score || (section.score === weakest.score && section.items > weakestItems)) {
      weakest = { id: section.id, title: section.title, score: section.score };
      weakestItems = section.items;
    }
  }

  return { pack: { score: mean(evidence.map((item) => item.value)), items: evidence.length }, sections, weakest };
}
