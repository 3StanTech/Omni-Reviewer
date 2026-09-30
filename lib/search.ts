/**
 * Pure helpers for pack search: query validation, snippet cleanup, and result
 * links. Importable by client and server (no node imports).
 */

import { stripCitations } from "@/lib/citations";
import { outlineHeadingHref, studyOutline } from "@/lib/study-outline";

export const MIN_SEARCH_QUERY_CHARS = 2;
export const MAX_SEARCH_QUERY_CHARS = 200;

/** Trim and collapse whitespace; null when the result is not 2 to 200 characters. */
export function parseSearchQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const query = raw.replace(/\s+/g, " ").trim();
  if (query.length < MIN_SEARCH_QUERY_CHARS || query.length > MAX_SEARCH_QUERY_CHARS) return null;
  return query;
}

export type SnippetSegment = { text: string; mark: boolean };

const PAGE_MARKER_LINES = /^<<<(?:page \d{1,4}|slide image)>>>$/gm;

const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RULE_ROW = /^\s*(?:[-*_=]\s*){3,}$/;

/** Drop Markdown syntax that reads as noise in a one-line snippet, keeping the words. */
function stripMarkdownNoise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !TABLE_SEPARATOR_ROW.test(line) && !RULE_ROW.test(line))
    .map((line) =>
      line
        .replace(/^\s*(?:>\s?)+/, "")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*[*+-]\s+/, "")
        .replace(/\|/g, " "),
    )
    .join("\n")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\*+|__+/g, "")
    .replace(/(^|[^\p{L}\p{N}_])_+(?=\S)/gu, "$1")
    .replace(/(?<=\S)_+(?![\p{L}\p{N}_])/gu, "");
}

/**
 * Turn a `ts_headline` snippet (matches wrapped in « and ») into plain text
 * segments. Citations, `[[unsourced]]`, page markers and Markdown syntax
 * (emphasis, headings, quotes, bullets, table pipes, code ticks, link URLs) are removed. Segments
 * are text only: callers render them as text nodes and never as HTML.
 */
export function cleanSnippet(raw: string): SnippetSegment[] {
  const text = stripMarkdownNoise(stripCitations(raw.replace(PAGE_MARKER_LINES, " ")))
    .replace(/\s+/g, " ")
    .trim();

  const segments: SnippetSegment[] = [];
  let mark = false;
  let buffer = "";
  const flush = () => {
    if (buffer) {
      const last = segments[segments.length - 1];
      if (last && last.mark === mark) last.text += buffer;
      else segments.push({ text: buffer, mark });
    }
    buffer = "";
  };
  for (const char of text) {
    if (char === "«") {
      flush();
      mark = true;
    } else if (char === "»") {
      flush();
      mark = false;
    } else {
      buffer += char;
    }
  }
  flush();
  return segments;
}

/**
 * Id of the nearest heading at or before `offset` in `markdown`, or null. Ids
 * come from `studyOutline`, so they match the rendered heading ids.
 */
export function sectionAnchorFor(markdown: string, offset: number): string | null {
  if (!markdown || !Number.isFinite(offset)) return null;
  const at = Math.min(Math.max(0, Math.floor(offset)), markdown.length);
  let end = markdown.indexOf("\n", at);
  if (end === -1) end = markdown.length;
  // A setext heading's underline belongs to the line above it.
  const next = markdown.indexOf("\n", end + 1);
  const following = markdown.slice(end + 1, next === -1 ? markdown.length : next);
  if (/^\s{0,3}(?:=+|-+)\s*$/.test(following)) end = next === -1 ? markdown.length : next;
  const headings = studyOutline(markdown.slice(0, end));
  return headings.length > 0 ? headings[headings.length - 1].id : null;
}

export type SearchResultKind = "source_page" | "locked_in" | "summary" | "card";

export type SearchLinkRow = {
  kind: SearchResultKind;
  topicId: string;
  reviewerId: string;
  sourceIndex?: number | null;
  sourceId?: string | null;
  page?: number | null;
  headingId?: string | null;
};

export function searchResultHref(row: SearchLinkRow): string {
  const base = `/topics/${encodeURIComponent(row.topicId)}/reviewers/${encodeURIComponent(row.reviewerId)}`;
  switch (row.kind) {
    case "source_page": {
      // The id resolves for every pack; the index only for packs with stored citation lists.
      const params: string[] = [];
      if (row.sourceId) params.push(`sourceId=${encodeURIComponent(row.sourceId)}`);
      if (row.sourceIndex != null) params.push(`source=${row.sourceIndex}`);
      if (params.length === 0) return base;
      if (row.page != null) params.push(`page=${row.page}`);
      return `${base}?${params.join("&")}`;
    }
    case "locked_in":
    case "summary":
      return `${base}?mode=${row.kind}${row.headingId ? outlineHeadingHref(row.headingId) : ""}`;
    case "card":
      return `${base}?mode=carded`;
  }
}

export function searchKindLabel(row: Pick<SearchLinkRow, "kind" | "page">): string {
  switch (row.kind) {
    case "source_page":
      return row.page != null && row.page > 0 ? `Slide ${row.page}` : "Source";
    case "locked_in":
      return "Locked In";
    case "summary":
      return "Summary";
    case "card":
      return "Card";
  }
}
