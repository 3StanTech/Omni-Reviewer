import { markdownLines } from "@/lib/study-sections";

/** A sentence that describes the document itself ("This guide covers...", "In this document, ..."). */
const FRAMING_SENTENCE = /^(?:In\s+)?this\s+(?:study\s+)?(?:guide|document|reviewer|summary|locked in)\b/i;

/**
 * Sentence ends: terminal punctuation, with any bracket citations right after
 * it, followed by whitespace or the end of the line. A trailing citation such
 * as "... first. [S1 p.2]" stays with its sentence.
 */
const SENTENCE_END = /[.!?]+(?:\s*\[[^\]\n]*\])*(?=\s|$)/g;

const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const LINE_PREFIX = /^(\s*(?:>\s*)*(?:(?:[-*+]|\d{1,9}[.)])\s+)?)/;
const LIST_MARKER = /(?:[-*+]|\d{1,9}[.)])\s+$/;

/** The line's sentences, each with its trailing whitespace, concatenating back to the input. */
function sentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    let end = match.index + match[0].length;
    while (end < text.length && /\s/.test(text[end])) end++;
    parts.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

function isFraming(sentence: string): boolean {
  return FRAMING_SENTENCE.test(sentence.trim().replace(/^[*_]+/, ""));
}

/**
 * The line without its framing sentences: the same string when it has none,
 * null when nothing but the prefix (indent, quote or list marker) is left.
 * The line's trailing whitespace, such as a Markdown hard break, is kept.
 */
function stripLine(text: string): string | null {
  const prefix = LINE_PREFIX.exec(text)?.[1] ?? "";
  const parts = sentences(text.slice(prefix.length));
  const kept = parts.filter((part) => !isFraming(part));
  if (kept.length === parts.length) return text;
  const body = kept.join("").trimEnd();
  const trailing = /\s*$/.exec(text)?.[0] ?? "";
  return body.trim() ? prefix + body + trailing : null;
}

/**
 * Remove sentences that describe the document itself, which free models write
 * despite the prompt rule. Fenced code, headings and any line with a "|"
 * (a table row, with or without leading pipes) are left alone; a list item or paragraph line left empty is dropped together with
 * the blank line that separated it. Every other line is unchanged.
 */
export function stripDocumentFraming(markdown: string): string {
  const lines = markdownLines(markdown);
  const output: string[] = [];
  let dropBlank = false;
  for (const line of lines) {
    const blank = line.text.trim() === "";
    if (dropBlank && blank && !line.fenced) {
      dropBlank = false;
      continue;
    }
    dropBlank = false;
    if (line.fenced || blank || line.text.includes("|") || ATX_HEADING.test(line.text)) {
      output.push(line.text);
      continue;
    }
    const stripped = stripLine(line.text);
    if (stripped !== null) {
      output.push(stripped);
      continue;
    }
    // A dropped list item keeps its neighbours tight; a dropped paragraph line
    // takes the blank line after it when it stood alone.
    const isListItem = LIST_MARKER.test(LINE_PREFIX.exec(line.text)?.[1] ?? "");
    const previous = output[output.length - 1];
    dropBlank = !isListItem && (previous === undefined || previous.trim() === "");
  }
  return output.join("\n");
}

const SELF_NOUN = "(?:study\\s+)?(?:document|guide|reviewer|text|material|materials|notes|lesson|summary|handout)";
const LEADING_PHRASE = `(?:according\\s+to|based\\s+on|from|in|as\\s+(?:described|stated|discussed|noted|shown|explained|mentioned)\\s+in)\\s+(?:the|this)\\s+${SELF_NOUN}`;
/** "According to the document, ..." or "As described in this guide, ..." opening a question or card. */
const LEADING_SELF_REFERENCE = new RegExp(`^(\\s*)${LEADING_PHRASE}\\s*,\\s*`, "i");
/** The same opening wrapped in emphasis ("**In the document,** ..."), unwrapped first. */
const EMPHASIZED_LEADING_SELF_REFERENCE = new RegExp(`^(\\s*)([*_]{1,3})(${LEADING_PHRASE}\\s*,?)\\2\\s*`, "i");
/** ", as described in the document" or " in the guide" inside a sentence; never "the text of ...". */
const INLINE_SELF_REFERENCE = new RegExp(
  `,?\\s+(?:as\\s+(?:described|stated|discussed|noted|shown|explained|mentioned)\\s+)?(?:in|from|according\\s+to|within)\\s+(?:the|this)\\s+${SELF_NOUN}(?!\\s+of\\b)(?=[\\s,.?!;:)]|$)`,
  "gi",
);

/**
 * Remove references to the study material itself from a Test Me question,
 * choice, explanation or card side ("According to the document, which ..." ->
 * "Which ..."). Free models write them despite the prompt rule; the learner
 * studies the content, not a document. Returns the text unchanged when
 * removing them would leave nothing.
 */
export function stripSelfReference(text: string): string {
  const stripped = text
    .replace(EMPHASIZED_LEADING_SELF_REFERENCE, (_, lead: string, _mark: string, phrase: string) => `${lead}${phrase.replace(/,?$/, ",")} `)
    .replace(LEADING_SELF_REFERENCE, (_, lead: string) => lead)
    .replace(INLINE_SELF_REFERENCE, "")
    .replace(/^(\s*)(\p{Ll})/u, (_, lead: string, first: string) => lead + first.toUpperCase());
  return stripped.trim() ? stripped : text;
}
