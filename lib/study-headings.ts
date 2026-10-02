import { citationPattern, UNSOURCED_TOKEN } from "@/lib/citations";
import { markdownLines } from "@/lib/study-sections";

const ATX_HEADING = /^(#{1,6})(\s)([\s\S]*)$/;
const NUMBERED_CAPTION = /^(Table|Figure)\s+\d+(?:\.\d+)*\s*[:.\-–—]\s*/i;

function sanitizeHeadingText(text: string): string {
  return text
    .split(UNSOURCED_TOKEN).join("")
    .replace(citationPattern(), "")
    .trimStart()
    .replace(NUMBERED_CAPTION, (_match, word: string) => `${word}: `);
}

/**
 * Tidy ATX headings outside fenced code: drop citations and unsourced markers,
 * turn slide numbering such as "Table 1.1:" into "Table:", collapse repeated
 * spaces and trim the end. Every other line is left byte-identical.
 */
export function sanitizeStudyHeadings(markdown: string): string {
  return markdownLines(markdown)
    .map(({ text, fenced }) => {
      const heading = fenced ? null : ATX_HEADING.exec(text);
      if (!heading) return text;
      const [, hashes, separator, rest] = heading;
      return `${hashes}${separator}${sanitizeHeadingText(rest)}`.replace(/ {2,}/g, " ").trimEnd();
    })
    .join("\n");
}
