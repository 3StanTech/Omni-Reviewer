/**
 * Card export: CSV for Anki (Basic and Cloze note types) and a plain-text file
 * in RemNote's text flashcard syntax. Pure so the files can be tested without
 * a browser; the component adds the CSV byte order mark and downloads.
 *
 * Conventions: comma separated, every field quoted with inner quotes doubled,
 * line breaks kept inside quoted fields, CRLF row endings, no header row and no
 * `#` directives. Text stays plain (no HTML conversion).
 *
 * RemNote text: one card per line, `Front >> Back` for basic cards and
 * `text with {{answer}}` for cloze cards, per RemNote's "How to Import
 * Flashcards from Text". Line breaks inside a card collapse to spaces, and
 * RemNote delimiters inside card text are split with a space.
 */

import { stripCitations, UNSOURCED_TOKEN } from "@/lib/citations";
import { isClozeCardFront, parseClozeText } from "@/lib/learning";
import { stripPageMarkers } from "@/lib/source-markers";
import { safeSegment, UNSOURCED_EXPORT_TEXT } from "@/lib/study-export";

/** The card fields an export reads. */
export type ExportCard = {
  front: string;
  back: string;
  kind?: "basic" | "cloze";
  archivedAt?: string | Date | null;
};

export type CardExportKind = "basic" | "cloze" | "remnote";

const ROW_END = "\r\n";
const MAX_FILENAME_LENGTH = 120;

/** RFC 4180 field: always quoted, inner quotes doubled, line breaks kept. */
export function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function csvRows(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => `${row.map(csvField).join(",")}${ROW_END}`).join("");
}

function replaceUnsourced(text: string): string {
  return text
    .split(UNSOURCED_TOKEN)
    .reduce((out, part, index) => {
      if (index === 0) return part;
      const needsSpace = out.length > 0 && !/\s$/.test(out);
      return `${out}${needsSpace ? " " : ""}${UNSOURCED_EXPORT_TEXT}${part}`;
    }, "");
}

function cleanText(text: string): string {
  return stripCitations(replaceUnsourced(stripPageMarkers(text))).trim();
}

function isLive(card: ExportCard): boolean {
  return !card.archivedAt;
}

/** Cloze only when the front parses; an unparsable "cloze" card exports as basic. */
export function isClozeExportCard(card: ExportCard): boolean {
  return isClozeCardFront(card.front);
}

/** `{{a}} and {{b}}` becomes `{{c1::a}} and {{c2::b}}`; other text is unchanged. */
export function toAnkiCloze(front: string): string {
  const parsed = parseClozeText(front);
  if (!parsed) return front;
  return parsed.segments
    .map((segment) => (segment.kind === "text" ? segment.value : `{{c${segment.index + 1}::${segment.value}}}`))
    .join("");
}

export function basicExportCards<T extends ExportCard>(cards: readonly T[]): T[] {
  return cards.filter((card) => isLive(card) && !isClozeExportCard(card));
}

export function clozeExportCards<T extends ExportCard>(cards: readonly T[]): T[] {
  return cards.filter((card) => isLive(card) && isClozeExportCard(card));
}

/** Front, Back rows for live non-cloze cards. */
export function cardsToBasicCsv(cards: readonly ExportCard[]): string {
  return csvRows(basicExportCards(cards).map((card) => [cleanText(card.front), cleanText(card.back)]));
}

/** Text, Extra rows for live cloze cards (Anki's Cloze note type). */
export function cardsToClozeCsv(cards: readonly ExportCard[]): string {
  return csvRows(
    clozeExportCards(cards).map((card) => [cleanText(toAnkiCloze(card.front)), cleanText(card.back)]),
  );
}

// RemNote card delimiters (basic, reverse, two-way, disabled, concept and
// descriptor) plus cloze braces. Any of them inside card text would change the card.
const REMNOTE_DELIMITER = />>|<<|<>|==|>-|::|;;|:>|:<|;<|\{\{|\}\}/;

/** One line of text with every RemNote delimiter split apart by a space. */
function remNoteSafe(text: string): string {
  let out = text.replace(/\s+/g, " ");
  for (let match = REMNOTE_DELIMITER.exec(out); match; match = REMNOTE_DELIMITER.exec(out)) {
    out = `${out.slice(0, match.index + 1)} ${out.slice(match.index + 1)}`;
  }
  return out;
}

function remNoteLine(card: ExportCard): string | null {
  if (isClozeExportCard(card)) {
    const parsed = parseClozeText(cleanText(card.front)) ?? parseClozeText(card.front);
    if (parsed) {
      const line = parsed.segments
        .map((segment) => (segment.kind === "text" ? remNoteSafe(segment.value) : `{{${remNoteSafe(segment.value).trim()}}}`))
        .join("")
        .replace(/ {2,}/g, " ")
        .trim();
      return line || null;
    }
  }
  const front = remNoteSafe(cleanText(card.front)).trim();
  const back = remNoteSafe(cleanText(card.back)).trim();
  if (!front) return null;
  return back ? `${front} >> ${back}` : `${front} >>`;
}

/** One RemNote card per line for every live card; empty when there are none. */
export function cardsToRemNoteText(cards: readonly ExportCard[]): string {
  return cards
    .filter(isLive)
    .map(remNoteLine)
    .filter((line): line is string => line !== null)
    .map((line) => `${line}\n`)
    .join("");
}

const FILE_LABELS: Record<CardExportKind, { label: string; suffix: string }> = {
  basic: { label: "Basic cards", suffix: ".csv" },
  cloze: { label: "Cloze cards", suffix: ".csv" },
  remnote: { label: "RemNote cards", suffix: ".txt" },
};

/** Safe download name: "<name> - Basic cards.csv", "- Cloze cards.csv" or "- RemNote cards.txt". */
export function cardExportFilename(reviewerName: string, kind: CardExportKind): string {
  const name = safeSegment(reviewerName) || "Pack";
  const { label, suffix } = FILE_LABELS[kind];
  let base = `${name} - ${label}`;
  if (base.length + suffix.length > MAX_FILENAME_LENGTH) {
    const room = MAX_FILENAME_LENGTH - suffix.length - ` - ${label}`.length;
    base = `${name.slice(0, room).trimEnd().replace(/[.\s-]+$/, "") || "Pack"} - ${label}`;
  }
  return `${base}${suffix}`;
}
