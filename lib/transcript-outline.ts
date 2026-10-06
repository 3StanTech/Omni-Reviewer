/**
 * The lecturer's OUTLINE block at the top of a med transcript.
 *
 * Transcripts open with a numbered outline (roman top-level entries, lettered
 * subs) naming the lecture's sections in teaching order. Parsing is purely
 * textual. PDF.js can interleave a two-column outline, so when the numbering
 * breaks, section order is recovered from the body headings instead.
 */

import { splitPages } from "@/lib/source-markers";

export type OutlineSection = { heading: string; subs: string[] };
export type TranscriptOutline = { sections: OutlineSection[] };

/** Search window for text without page markers. */
const UNMARKED_WINDOW = 6_000;
const MIN_SECTIONS = 2;
/** Share of top-level entries whose body heading must be found to trust a recovered order. */
const MIN_BODY_MATCH = 0.6;

const OUTLINE_LINE = /^outline$/i;
const STOP_LINE = /^(summary of abbreviations|learning objectives)\b/i;
const LEGEND_LINE = /^(must|lecturer)\b/i;
const ROMAN_ENTRY = /^([IVXL]+)\.\s*(.*)$/;
const LETTER_ENTRY = /^([A-Z])\.\s*(.*)$/;
const NON_CONTENT = /^(review questions|references|formative quiz|quiz|appendix|answer key)\b/i;

type Entry = { numeral: string; firstLine: string; heading: string; subs: string[] };

const ROMAN_VALUES: ReadonlyArray<[string, number]> = [
  ["L", 50],
  ["XL", 40],
  ["X", 10],
  ["IX", 9],
  ["V", 5],
  ["IV", 4],
  ["I", 1],
];

function toRoman(value: number): string {
  let rest = value;
  let numeral = "";
  for (const [symbol, amount] of ROMAN_VALUES) {
    while (rest >= amount) {
      numeral += symbol;
      rest -= amount;
    }
  }
  return numeral;
}

/** Value of a well-formed numeral up to L, or 0. */
function romanValue(numeral: string): number {
  for (let value = 1; value <= 50; value++) {
    if (toRoman(value) === numeral) return value;
  }
  return 0;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The first two pages, or the first characters of unmarked text, plus everything after. */
function searchWindow(sourceText: string): { head: string; tail: string } {
  const pages = splitPages(sourceText);
  if (pages.length === 1 && pages[0].page === 0) {
    return {
      head: sourceText.slice(0, UNMARKED_WINDOW),
      tail: sourceText.slice(UNMARKED_WINDOW),
    };
  }
  return {
    head: pages.filter((entry) => entry.page <= 2).map((entry) => entry.text).join("\n"),
    tail: pages.filter((entry) => entry.page > 2).map((entry) => entry.text).join("\n"),
  };
}

/** True for the body's own uppercase heading of entry I, which means the outline ended. */
function isFirstBodyHeading(line: string, first: Entry | undefined): boolean {
  if (!first) return false;
  const match = /^I\.\s*(.+)$/.exec(line);
  if (!match) return false;
  const letters = match[1].replace(/[^\p{L}]/gu, "");
  const text = normalize(match[1]);
  return (
    letters.length > 0 &&
    letters === letters.toUpperCase() &&
    text.length > 0 &&
    normalize(first.heading).startsWith(text)
  );
}

function isBodyHeading(line: string, entry: Entry): boolean {
  const match = ROMAN_ENTRY.exec(line.trim());
  if (!match || match[1] !== entry.numeral) return false;
  const body = normalize(match[2]);
  const title = normalize(entry.firstLine || entry.heading);
  return body.length > 0 && title.length > 0 && (body.startsWith(title) || title.startsWith(body));
}

/** Entries ordered by where their headings first appear in the body, or null when too few appear. */
function bodyOrder(entries: Entry[], bodyLines: string[]): Entry[] | null {
  const positions = entries.map((entry) =>
    bodyLines.findIndex((line) => isBodyHeading(line, entry)),
  );
  const found = positions.filter((position) => position >= 0).length;
  if (found < entries.length * MIN_BODY_MATCH) return null;
  return entries
    .map((entry, index) => ({
      entry,
      position: positions[index] >= 0 ? positions[index] : bodyLines.length + index,
    }))
    .sort((a, b) => a.position - b.position)
    .map(({ entry }) => entry);
}

export function detectOutline(sourceText: string): TranscriptOutline | null {
  const { head, tail } = searchWindow(sourceText);
  const lines = head.split("\n");
  const start = lines.findIndex((line) => OUTLINE_LINE.test(line.trim()));
  if (start < 0) return null;

  const entries: Entry[] = [];
  let broken = false;
  let lastWasSub = false;
  let end = lines.length;

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (STOP_LINE.test(line) || LEGEND_LINE.test(line) || isFirstBodyHeading(line, entries[0])) {
      end = index;
      break;
    }

    const current = entries.at(-1);
    const roman = ROMAN_ENTRY.exec(line);
    const numeral = roman && romanValue(roman[1]) > 0 ? roman[1] : null;
    const title = roman?.[2] ?? "";
    const letter = LETTER_ENTRY.exec(line);
    const nextRoman = toRoman(current ? romanValue(current.numeral) + 1 : 1);
    const nextLetter = current ? String.fromCharCode(65 + current.subs.length) : null;
    // A single letter that is also a used numeral (I, V, X, L) can only be a sub.
    const newTop =
      numeral !== null &&
      (numeral.length > 1 || !entries.some((entry) => entry.numeral === numeral));

    if (numeral && numeral === nextRoman) {
      entries.push({ numeral, firstLine: title, heading: title, subs: [] });
      lastWasSub = false;
    } else if (letter && current && letter[1] === nextLetter) {
      current.subs.push(letter[2]);
      lastWasSub = true;
    } else if (numeral && newTop) {
      broken = true;
      entries.push({ numeral, firstLine: title, heading: title, subs: [] });
      lastWasSub = false;
    } else if (letter && current) {
      broken = true;
      current.subs.push(letter[2]);
      lastWasSub = true;
    } else if (current) {
      if (lastWasSub) {
        const last = current.subs.length - 1;
        current.subs[last] = `${current.subs[last]} ${line}`;
      } else {
        current.heading = `${current.heading} ${line}`;
      }
    }
  }

  let content = entries.filter((entry) => !NON_CONTENT.test(clean(entry.heading)));
  if (broken) {
    const bodyLines = [...lines.slice(end), ...tail.split("\n")];
    const ordered = bodyOrder(content, bodyLines);
    if (!ordered) return null;
    content = ordered;
  }
  if (content.length < MIN_SECTIONS) return null;

  return {
    sections: content.map((entry) => ({
      heading: clean(entry.heading),
      subs: entry.subs.map(clean).filter(Boolean),
    })),
  };
}
