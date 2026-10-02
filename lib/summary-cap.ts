import { citationPattern, UNSOURCED_TOKEN } from "@/lib/citations";
import { markdownLines } from "@/lib/study-sections";

/** Bullets kept in a Summary section with no matching limit (the prompt's ceiling). */
const DEFAULT_SECTION_BULLETS = 14;

const LIST_ITEM = /^( *)(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Heading text for matching: lowercase, without citations or unsourced tags, single-spaced. */
function headingKey(heading: string): string {
  return heading
    .replace(citationPattern(), " ")
    .split(UNSOURCED_TOKEN).join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function indentOf(text: string): number {
  return /^[ \t]*/.exec(text)?.[0].replace(/\t/g, "    ").length ?? 0;
}

function isTableDelimiter(text: string): boolean {
  return text.includes("|") && text.includes("-") && TABLE_DELIMITER.test(text);
}

/**
 * Cap an over-long Summary in code: in each "##" section keep the first N
 * top-level list items (N from the section's limit, matched by heading; 14
 * when none matches) with their children, and the header, delimiter and first
 * `maxTableRows` rows of each table. Paragraphs, subheadings, blank lines,
 * fenced code and the preamble stay; every kept line is unchanged.
 */
export function capSummarySections(
  markdown: string,
  limits: ReadonlyArray<{ heading: string; bullets: number }>,
  maxTableRows = 6,
): string {
  const bulletsByHeading = new Map<string, number>();
  for (const limit of limits) {
    const key = headingKey(limit.heading);
    if (!bulletsByHeading.has(key)) bulletsByHeading.set(key, limit.bullets);
  }
  const lines = markdownLines(markdown);
  const output: string[] = [];
  /** Bullets allowed in the current "##" section; null in the preamble. */
  let allowed: number | null = null;
  let itemsSeen = 0;
  /** Indent of the open top-level item, and whether it is being kept. */
  let item: { indent: number; kept: boolean } | null = null;
  /** Data rows left to keep in the open table; null outside a table. */
  let tableRowsLeft: number | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const text = line.text;
    const blank = text.trim() === "";

    if (line.fenced) {
      item = null;
      tableRowsLeft = null;
      output.push(text);
      continue;
    }
    if (text.startsWith("## ")) {
      allowed = bulletsByHeading.get(headingKey(text.slice(3))) ?? DEFAULT_SECTION_BULLETS;
      itemsSeen = 0;
      item = null;
      tableRowsLeft = null;
      output.push(text);
      continue;
    }
    if (allowed === null) {
      output.push(text);
      continue;
    }

    if (tableRowsLeft !== null) {
      if (!blank && text.includes("|")) {
        if (tableRowsLeft > 0) {
          tableRowsLeft--;
          output.push(text);
        }
        continue;
      }
      tableRowsLeft = null;
    }

    if (item) {
      // Children, continuation lines and blank lines inside a loose item
      // belong to the open item until a heading, table or new top-level item.
      const listMatch = LIST_ITEM.exec(text);
      const nextText = lines[index + 1]?.text ?? "";
      const nextContinues = blank && !lines[index + 1]?.fenced && nextText.trim() !== "" &&
        indentOf(nextText) > item.indent && !ATX_HEADING.test(nextText);
      const continues = blank
        ? nextContinues
        : !ATX_HEADING.test(text) && !text.includes("|") &&
          (listMatch ? listMatch[1].length > item.indent : true);
      if (continues) {
        if (item.kept) output.push(text);
        continue;
      }
      item = null;
    }

    const listMatch = LIST_ITEM.exec(text);
    if (listMatch && listMatch[1].length <= 3) {
      itemsSeen++;
      item = { indent: listMatch[1].length, kept: itemsSeen <= allowed };
      if (item.kept) output.push(text);
      continue;
    }

    if (text.includes("|") && isTableDelimiter(lines[index + 1]?.text ?? "") && !lines[index + 1]?.fenced) {
      output.push(text, lines[index + 1].text);
      index++;
      tableRowsLeft = maxTableRows;
      continue;
    }

    output.push(text);
  }
  return output.join("\n");
}
