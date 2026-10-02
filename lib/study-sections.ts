import { citedPageCount } from "@/lib/ai-budgets";

export type StudySection = { heading: string; markdown: string };

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/;

/** The fence marker a line opens; a backtick fence whose info string has a backtick is not a fence (CommonMark). */
function openingFence(text: string): string | null {
  const match = OPENING_FENCE.exec(text);
  if (!match) return null;
  const [, marker, info] = match;
  return marker[0] === "`" && info.includes("`") ? null : marker;
}

function closesFence(text: string, fence: string): boolean {
  const marker = CLOSING_FENCE.exec(text)?.[1];
  return marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length;
}

export type MarkdownLine = { start: number; text: string; fenced: boolean };

/**
 * Every line (without its "\n") with its start offset. `fenced` marks fence
 * delimiters and the code between them; a fence closes only on a bare line of
 * the same character repeated at least as many times. `lines.map(l => l.text).join("\n")`
 * rebuilds the input.
 */
export function markdownLines(markdown: string): MarkdownLine[] {
  const result: MarkdownLine[] = [];
  let fence: string | null = null;
  let start = 0;
  for (;;) {
    const newline = markdown.indexOf("\n", start);
    const text = markdown.slice(start, newline === -1 ? markdown.length : newline);
    if (fence) {
      result.push({ start, text, fenced: true });
      if (closesFence(text, fence)) fence = null;
    } else {
      fence = openingFence(text);
      result.push({ start, text, fenced: fence !== null });
    }
    if (newline === -1) return result;
    start = newline + 1;
  }
}

/** Split Markdown at "## " headings outside fenced code; the parts concatenate back to the input. */
export function splitSections(markdown: string): { preamble: string; sections: StudySection[] } {
  const starts = markdownLines(markdown)
    .filter((line) => !line.fenced && line.text.startsWith("## "))
    .map((line) => ({ start: line.start, heading: line.text.slice(3).trim() }));
  if (starts.length === 0) return { preamble: markdown, sections: [] };
  const sections = starts.map(({ start, heading }, index) => ({
    heading,
    markdown: markdown.slice(start, starts[index + 1]?.start ?? markdown.length),
  }));
  return { preamble: markdown.slice(0, starts[0].start), sections };
}

/** Two halves split at the "## " boundary that best balances their lengths; one part when there is no boundary. */
export function balancedHalves(markdown: string): string[] {
  const { preamble, sections } = splitSections(markdown);
  if (sections.length < 2) return [markdown];
  let firstLength = preamble.length;
  let bestSplit = 0;
  let bestDiff = Infinity;
  for (let k = 1; k < sections.length; k++) {
    firstLength += sections[k - 1].markdown.length;
    const diff = Math.abs(markdown.length - 2 * firstLength);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = firstLength;
    }
  }
  return [markdown.slice(0, bestSplit), markdown.slice(bestSplit)];
}

/** "##" sections in a half; a half with other content but no "##" counts as one. */
function sectionCount(half: string): number {
  const count = splitSections(half).sections.length;
  return count === 0 && /\S/.test(half) ? 1 : count;
}

/**
 * Share an item target between halves by cited pages (string length when
 * nothing is page-cited), with at least one item per section in each half when
 * the total allows; otherwise split by section counts.
 */
export function allocateItems(total: number, halves: string[]): number[] {
  if (halves.length === 1) return [total];
  if (halves.length !== 2) throw new Error("allocateItems expects one or two halves");
  const [firstSections, secondSections] = halves.map(sectionCount);
  let first: number;
  if (total >= firstSections + secondSections) {
    let weights = halves.map(citedPageCount);
    if (weights[0] + weights[1] === 0) weights = halves.map((half) => half.length);
    const sum = weights[0] + weights[1];
    first = Math.round(sum === 0 ? total / 2 : (total * weights[0]) / sum);
    first = Math.min(total - secondSections, Math.max(firstSections, first));
  } else {
    first = Math.round((total * firstSections) / (firstSections + secondSections));
    if (total >= 2 && firstSections > 0 && secondSections > 0) first = Math.min(total - 1, Math.max(1, first));
  }
  return [first, total - first];
}
