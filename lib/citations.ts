/**
 * Inline source citations in generated study Markdown.
 *
 * Grammar (the model is asked to end each factual sentence with one):
 *   [S1 p.14]      page or slide 14 of source 1
 *   [S1 pp.14-15]  pages 14 to 15 of source 1
 *   [S2]           the whole of source 2 (sources without pages)
 *   [S1 p.2, p.3]  a comma list of pages or ranges in one source (one chip each)
 *
 * `[[unsourced]]` follows a sentence the grounding check could not find in the
 * uploaded sources. Both forms are plain text in storage, so edits, revision
 * checks, and export keep working without schema changes.
 */

export const UNSOURCED_TOKEN = "[[unsourced]]";

// Models often write a range with a single "p." ("p.9-10"); accept it as a range.
const PAGE_SPEC = String.raw`(?:pp?\.\d{1,4}(?:-\d{1,4})?)`;
const CITATION_SOURCE = String.raw`\[S(\d{1,2})( ${PAGE_SPEC}(?:, ?${PAGE_SPEC})*)?\]`;

export function citationPattern(): RegExp {
  return new RegExp(CITATION_SOURCE, "g");
}

export type Citation = {
  /** Full matched text, for example "[S1 p.14]". */
  raw: string;
  /** 1-based source index as shown to the model. */
  source: number;
  /** First cited page, or null for a whole-source citation. */
  pageStart: number | null;
  /** Last cited page, equal to pageStart for a single page. */
  pageEnd: number | null;
  index: number;
};

export function parseCitations(text: string): Citation[] {
  const citations: Citation[] = [];
  for (const match of text.matchAll(citationPattern())) {
    const source = Number(match[1]);
    const specs = match[2] ? match[2].split(",").map((spec) => spec.trim()) : [];
    if (specs.length === 0) {
      citations.push({ raw: match[0], source, pageStart: null, pageEnd: null, index: match.index ?? 0 });
      continue;
    }
    for (const spec of specs) {
      const pages = /^pp?\.(\d+)(?:-(\d+))?$/.exec(spec);
      const pageStart = Number(pages?.[1]);
      const rangeEnd = pages?.[2] ? Number(pages[2]) : pageStart;
      citations.push({
        raw: match[0],
        source,
        pageStart,
        pageEnd: rangeEnd >= pageStart ? rangeEnd : pageStart,
        index: match.index ?? 0,
      });
    }
  }
  return citations;
}

/** Short chip label: "p.14", "pp.14-15", or "S2". */
export function citationLabel(citation: Pick<Citation, "source" | "pageStart" | "pageEnd">): string {
  if (citation.pageStart === null) return `S${citation.source}`;
  if (citation.pageEnd !== null && citation.pageEnd !== citation.pageStart) {
    return `pp.${citation.pageStart}-${citation.pageEnd}`;
  }
  return `p.${citation.pageStart}`;
}

/** Remove citations and unsourced tokens, tidying the spaces they leave. */
export function stripCitations(text: string): string {
  return text
    .split(UNSOURCED_TOKEN).join("")
    .replace(citationPattern(), "")
    .replace(/[ \t]+([.,;:!?)])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
}

/** Drop citations whose source index is not in the pack (1..sourceCount). */
export function dropUnknownSourceCitations(text: string, sourceCount: number): string {
  return text.replace(citationPattern(), (raw, source: string) => {
    const index = Number(source);
    return index >= 1 && index <= sourceCount ? raw : "";
  });
}

const UNSOURCED_SOURCE = String.raw`\[\[unsourced\]\]`;
const CLOSERS = `"'”’)`;
/** Terminal punctuation, closers, then any trailing citations or unsourced token. */
const SENTENCE_END = new RegExp(
  String.raw`[.!?]+[${CLOSERS}]*(?:\s*(?:${CITATION_SOURCE}|${UNSOURCED_SOURCE}))*(?=\s|$)`,
  "g",
);

export type ClaimSentence = {
  text: string;
  start: number;
  end: number;
  /** "tableRow" for a GFM table body row (outer pipes trimmed), else "prose". */
  kind: "prose" | "tableRow";
};

/**
 * Words that end in a period without ending a sentence. The grounding checker
 * (lib/grounding.ts) uses the same rule through isSentenceAbbreviation.
 */
export const SENTENCE_ABBREVIATIONS: ReadonlySet<string> = new Set(["eg", "ie", "vs", "dr", "mr", "mrs", "ms", "fig", "approx", "no", "st", "cf", "al"]);

/** True when the period at `dotIndex` closes an abbreviation such as "e.g." or "Fig.". */
export function isSentenceAbbreviation(text: string, dotIndex: number, from = 0): boolean {
  const before = text.slice(from, dotIndex);
  const word = /([\p{L}]+)$/u.exec(before)?.[1];
  if (!word) return false;
  if (SENTENCE_ABBREVIATIONS.has(word.toLowerCase())) return true;
  const preceding = before[before.length - word.length - 1];
  if (word.length === 1 && preceding === ".") return true;
  // A genus initial ("*H. influenzae*", "E. coli") is followed by a lowercase
  // species name; "Hepatitis B. Patients" still ends a sentence.
  return /^\p{Lu}$/u.test(word)
    && (preceding === undefined || /[\s*_(]/.test(preceding))
    && /^\s+[*_]?\p{Ll}/u.test(text.slice(dotIndex + 1));
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_MARKER = /^(\s*(?:>\s?)*\s*)(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;
const QUOTE_PREFIX = /^\s*(?:>\s?)+\s*/;
const INLINE_CODE = /(`+)[^`]*?\1/g;
const INLINE_MATH = /\$\$[^$]*\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)/g;

function maskSpans(text: string): string {
  const mask = (match: string) => "x".repeat(match.length);
  return text.replace(INLINE_CODE, mask).replace(INLINE_MATH, mask);
}

function trimmedRange(
  markdown: string,
  start: number,
  end: number,
  kind: ClaimSentence["kind"] = "prose",
): ClaimSentence | null {
  while (start < end && /\s/.test(markdown[start])) start += 1;
  while (end > start && /\s/.test(markdown[end - 1])) end -= 1;
  return end > start ? { text: markdown.slice(start, end), start, end, kind } : null;
}

/**
 * Split generated Markdown into claim units with offsets into the original.
 *
 * Line-based heuristics, deliberately simple and deterministic:
 * - Fenced code (``` / ~~~) and display math ($$ or \[ on their own lines) are skipped.
 * - Headings, thematic breaks, and table header + separator rows are skipped.
 * - Each table body row is one claim (outer pipes trimmed).
 * - A blank line, heading, or list marker starts a new block; other lines join the
 *   current block (paragraph or list item, including lazy continuations).
 * - Blocks split into sentences at . ! ? (plus closing quotes/parens) followed by
 *   whitespace; trailing citations and `[[unsourced]]` stay with that sentence.
 *   Inline code and inline math are masked so their punctuation never splits.
 * - A period that closes an abbreviation ("e.g.", "Fig.", "vs.") does not split,
 *   using the same rule as the grounding checker.
 */
export function claimSentences(markdown: string): ClaimSentence[] {
  const claims: ClaimSentence[] = [];
  const lines: { text: string; start: number }[] = [];
  let offset = 0;
  for (const raw of markdown.split("\n")) {
    lines.push({ text: raw.replace(/\r$/, ""), start: offset });
    offset += raw.length + 1;
  }

  let block: { start: number; end: number } | null = null;
  const flush = () => {
    if (!block) return;
    const region = markdown.slice(block.start, block.end);
    const masked = maskSpans(region);
    let cursor = 0;
    for (const match of masked.matchAll(SENTENCE_END)) {
      if (match[0][0] === "." && isSentenceAbbreviation(masked, match.index ?? 0, cursor)) continue;
      const stop = (match.index ?? 0) + match[0].length;
      const claim = trimmedRange(markdown, block.start + cursor, block.start + stop);
      if (claim) claims.push(claim);
      cursor = stop;
    }
    const rest = trimmedRange(markdown, block.start + cursor, block.end);
    if (rest) claims.push(rest);
    block = null;
  };

  let fence: string | null = null;
  let displayMath: "$$" | "\\]" | null = null;
  let inTable = false;

  for (let index = 0; index < lines.length; index += 1) {
    const { text, start } = lines[index];
    const trimmed = text.trim();

    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (displayMath) {
      if (trimmed.endsWith(displayMath)) displayMath = null;
      continue;
    }
    const fenceMatch = FENCE.exec(text);
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      continue;
    }
    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      flush();
      const closer = trimmed.startsWith("$$") ? "$$" : "\\]";
      const closedOnLine = trimmed.length > 2 && trimmed.slice(2).trimEnd().endsWith(closer);
      if (!closedOnLine) displayMath = closer;
      continue;
    }
    if (!trimmed) {
      flush();
      inTable = false;
      continue;
    }
    if (HEADING.test(text) || THEMATIC_BREAK.test(text)) {
      flush();
      inTable = false;
      continue;
    }

    const next = lines[index + 1]?.text ?? "";
    if (text.includes("|") && TABLE_SEPARATOR.test(next) && next.includes("-")) {
      flush();
      inTable = true;
      index += 1;
      continue;
    }
    if (inTable) {
      if (text.includes("|")) {
        const leading = text.length - text.trimStart().length;
        let rowStart = start + leading;
        let rowEnd = start + text.trimEnd().length;
        if (markdown[rowStart] === "|") rowStart += 1;
        if (rowEnd > rowStart && markdown[rowEnd - 1] === "|") rowEnd -= 1;
        const claim = trimmedRange(markdown, rowStart, rowEnd, "tableRow");
        if (claim) claims.push(claim);
        continue;
      }
      inTable = false;
    }

    const marker = LIST_MARKER.exec(text);
    if (marker) {
      flush();
      block = { start: start + marker[0].length, end: start + text.length };
      continue;
    }
    if (block) {
      block.end = start + text.length;
      continue;
    }
    const quote = QUOTE_PREFIX.exec(text);
    block = { start: start + (quote ? quote[0].length : 0), end: start + text.length };
  }
  flush();
  return claims;
}

function claimWordCount(text: string): number {
  return stripCitations(text)
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * Count claim units with at least six words (citations excluded), how many of
 * those carry a citation, and how many carry the unsourced token.
 */
export function countClaims(markdown: string): { total: number; cited: number; unsourced: number } {
  let total = 0;
  let cited = 0;
  let unsourced = 0;
  for (const claim of claimSentences(markdown)) {
    if (claimWordCount(claim.text) < 6) continue;
    total += 1;
    if (parseCitations(claim.text).length > 0) cited += 1;
    if (claim.text.includes(UNSOURCED_TOKEN)) unsourced += 1;
  }
  return { total, cited, unsourced };
}

type CitationNode = {
  type: string;
  value?: string;
  children?: CitationNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string | string[]>;
  };
};

const CITE_NODE = "studyCitation";
const UNSOURCED_NODE = "studyUnsourced";
const CLAIM_NODE = "studyClaim";

/**
 * mdast node types emitted by `remarkCitations` that carry no study text. The
 * annotation text model skips them exactly like footnotes so chips never shift
 * canonical offsets.
 */
export const CITATION_NODE_TYPES: ReadonlySet<string> = new Set([CITE_NODE, UNSOURCED_NODE]);
const CITATION_OR_UNSOURCED = new RegExp(`${CITATION_SOURCE}|${UNSOURCED_SOURCE}`, "g");
const SKIPPED_PARENTS = new Set(["code", "inlineCode", "math", "inlineMath", "html"]);
/** Sentence boundary inside prose: punctuation, closers, whitespace. */
const PROSE_BOUNDARY = new RegExp(String.raw`[.!?]+[${CLOSERS}]*\s+`, "g");

function citationNodes(raw: string): CitationNode[] {
  const nodes: CitationNode[] = [];
  for (const citation of parseCitations(raw)) {
    const hProperties: Record<string, string | string[]> = {
      className: ["study-cite"],
      dataCiteSource: String(citation.source),
    };
    if (citation.pageStart !== null) {
      hProperties.dataCitePageStart = String(citation.pageStart);
      hProperties.dataCitePageEnd = String(citation.pageEnd ?? citation.pageStart);
    }
    hProperties.dataStudySkip = "";
    if (nodes.length > 0) nodes.push({ type: "text", value: " " });
    nodes.push({
      type: CITE_NODE,
      data: { hName: "span", hProperties },
      children: [{ type: "text", value: citationLabel(citation) }],
    });
  }
  return nodes;
}

function unsourcedNode(): CitationNode {
  return {
    type: UNSOURCED_NODE,
    data: {
      hName: "span",
      hProperties: { className: ["study-unsourced"], dataUnsourced: "", dataStudySkip: "" },
    },
    children: [],
  };
}

function claimNode(children: CitationNode[]): CitationNode {
  return {
    type: CLAIM_NODE,
    data: { hName: "span", hProperties: { className: ["study-claim"], dataClaim: "unsourced" } },
    children,
  };
}

function splitTextNode(node: CitationNode): CitationNode[] {
  const value = node.value ?? "";
  const parts: CitationNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(CITATION_OR_UNSOURCED)) {
    const at = match.index ?? 0;
    if (at > cursor) parts.push({ type: "text", value: value.slice(cursor, at) });
    if (match[0] === UNSOURCED_TOKEN) parts.push(unsourcedNode());
    else parts.push(...citationNodes(match[0]));
    cursor = at + match[0].length;
  }
  if (cursor === 0) return [node];
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}

function nodeText(node: CitationNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

function lastBoundaryEnd(text: string): number {
  let end = -1;
  for (const match of text.matchAll(PROSE_BOUNDARY)) end = (match.index ?? 0) + match[0].length;
  return end;
}

/**
 * Move the sentence that ends at the tail of `out` into a claim wrapper.
 * Walks back through siblings until a sentence boundary inside a text node, a
 * previous citation/unsourced chip, a line break, raw HTML, or the parent start.
 * Formatting siblings (strong, emphasis, link, inline code/math) are wrapped
 * whole. Limitation: when a sentence boundary falls inside a formatting node
 * (for example `**One. Two**`), the wrapper is skipped rather than splitting it.
 */
function wrapPrecedingClaim(out: CitationNode[]): void {
  const parts: CitationNode[] = [];
  let trailing = "";
  let prefix = "";
  let removeFrom = out.length;
  let adjacent = true;

  for (let index = out.length - 1; index >= 0; index -= 1) {
    const node = out[index];
    if (node.type === "text") {
      let value = node.value ?? "";
      let searchEnd = value.length;
      if (adjacent) {
        trailing = /\s*$/.exec(value)?.[0] ?? "";
        value = value.slice(0, value.length - trailing.length);
        searchEnd = value.replace(new RegExp(`[.!?]+[${CLOSERS}]*$`), "").length;
      }
      const cut = lastBoundaryEnd(value.slice(0, searchEnd));
      removeFrom = index;
      adjacent = false;
      if (cut >= 0) {
        prefix = value.slice(0, cut);
        if (cut < value.length) parts.unshift({ type: "text", value: value.slice(cut) });
        break;
      }
      if (value) parts.unshift({ type: "text", value });
      continue;
    }
    // A citation followed only by the sentence's closing punctuation ends this
    // claim ("growth [S1 p.3]."), so it belongs inside the wrapper.
    if (node.type === CITE_NODE && !parts.some((part) => /[\p{L}\p{N}]/u.test(nodeText(part)))) {
      parts.unshift(node);
      removeFrom = index;
      continue;
    }
    if ([CITE_NODE, UNSOURCED_NODE, CLAIM_NODE, "break", "html"].includes(node.type)) break;
    if (node.type !== "inlineCode" && node.type !== "inlineMath") {
      const inner = nodeText(node);
      if (lastBoundaryEnd(inner) >= 0) return;
      // A formatted run ending in terminal punctuation closes the previous sentence.
      if (!adjacent && new RegExp(`[.!?]+[${CLOSERS}]*$`).test(inner)) break;
    }
    parts.unshift(node);
    removeFrom = index;
    adjacent = false;
  }

  if (!parts.some((part) => nodeText(part).trim())) return;
  const first = parts[0];
  if (first.type === "text") {
    const leading = /^\s*/.exec(first.value ?? "")?.[0] ?? "";
    prefix += leading;
    first.value = (first.value ?? "").slice(leading.length);
  }
  out.splice(removeFrom);
  if (prefix) out.push({ type: "text", value: prefix });
  out.push(claimNode(parts));
  if (trailing) out.push({ type: "text", value: trailing });
}

function transformCitations(node: CitationNode): void {
  if (!node.children || SKIPPED_PARENTS.has(node.type)) return;
  const out: CitationNode[] = [];
  for (const child of node.children) {
    if (child.type !== "text") {
      transformCitations(child);
      out.push(child);
      continue;
    }
    for (const part of splitTextNode(child)) {
      if (part.type === UNSOURCED_NODE) wrapPrecedingClaim(out);
      out.push(part);
    }
  }
  node.children = out;
}

/**
 * Replace citation text with non-annotatable chips and `[[unsourced]]` with a
 * marker span, wrapping the preceding sentence as an unsourced claim. Runs on
 * mdast before remark-rehype; code and math nodes are never touched.
 */
export function remarkCitations() {
  return (tree: CitationNode) => {
    transformCitations(tree);
  };
}

/**
 * Which uploaded source each `S<n>` in a generated document refers to. Stored on
 * the Locked In and Summary views (`contentJson.citationSources`) at generation
 * time, so later uploads or deletions never re-point old citations.
 */
export type CitationSourceRef = {
  index: number;
  sourceId: string;
  filename: string;
  hasPages: boolean;
};

/** `contentJson` shape for generated Locked In and Summary views. */
export type StudyDocumentMeta = {
  citationSources: CitationSourceRef[];
  grounding?: {
    total: number;
    cited: number;
    lexicalSupported: number;
    verifiedSupported: number;
    unsourced: number;
    truncated: boolean;
    verifierFailed: boolean;
    unchecked?: number;
    /** Keys of untagged claims left unchecked, so Check again can reach them. */
    uncheckedKeys?: string[];
    /** Supported claims tagged by the term guard; included in unsourced. */
    termFlagged?: number;
  };
};

const MAX_UNCHECKED_KEYS = 500;
const MAX_UNCHECKED_KEY_CHARS = 16;

function isUncheckedKeyList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_UNCHECKED_KEYS
    && value.every((key) => typeof key === "string" && key.length <= MAX_UNCHECKED_KEY_CHARS);
}

export function readStudyDocumentMeta(contentJson: unknown): StudyDocumentMeta | null {
  if (!contentJson || typeof contentJson !== "object" || Array.isArray(contentJson)) return null;
  const refs = (contentJson as { citationSources?: unknown }).citationSources;
  if (!Array.isArray(refs)) return null;
  const citationSources = refs.filter(
    (ref): ref is CitationSourceRef =>
      Boolean(ref) &&
      typeof ref === "object" &&
      Number.isInteger((ref as CitationSourceRef).index) &&
      typeof (ref as CitationSourceRef).sourceId === "string" &&
      typeof (ref as CitationSourceRef).filename === "string" &&
      typeof (ref as CitationSourceRef).hasPages === "boolean",
  );
  const raw = (contentJson as { grounding?: unknown }).grounding;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { citationSources };
  // A malformed key list or term-guard count is dropped; the rest of the report is kept.
  const { uncheckedKeys, termFlagged, ...rest } = raw as NonNullable<StudyDocumentMeta["grounding"]>;
  const grounding: NonNullable<StudyDocumentMeta["grounding"]> = isUncheckedKeyList(uncheckedKeys) ? { ...rest, uncheckedKeys } : rest;
  if (Number.isSafeInteger(termFlagged) && (termFlagged as number) >= 0) grounding.termFlagged = termFlagged;
  return { citationSources, grounding };
}


/**
 * Mask everything `remarkCitations` never reads (fenced code, display math,
 * inline code, inline math) with same-length filler, so token offsets found in
 * the result are offsets into the original Markdown.
 */
function maskNonProse(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let displayMath: "$$" | "\\]" | null = null;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    const blank = line.replace(/[^\r]/g, "x");
    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
      out.push(blank);
      continue;
    }
    if (displayMath) {
      if (trimmed.endsWith(displayMath)) displayMath = null;
      out.push(blank);
      continue;
    }
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push(blank);
      continue;
    }
    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const closer = trimmed.startsWith("$$") ? "$$" : "\\]";
      const closedOnLine = trimmed.length > 2 && trimmed.slice(2).trimEnd().endsWith(closer);
      if (!closedOnLine) displayMath = closer;
      out.push(blank);
      continue;
    }
    out.push(maskSpans(line));
  }
  return out.join("\n");
}

/**
 * Offsets of every `[[unsourced]]` token the reader renders as a tag, in
 * document order. The nth rendered tag corresponds to the nth offset.
 */
export function unsourcedTokenOffsets(markdown: string): number[] {
  const masked = maskNonProse(markdown);
  const offsets: number[] = [];
  for (let at = masked.indexOf(UNSOURCED_TOKEN); at >= 0; at = masked.indexOf(UNSOURCED_TOKEN, at + UNSOURCED_TOKEN.length)) {
    offsets.push(at);
  }
  return offsets;
}

export type UnsourcedResolution = "keep" | "delete";

const ONLY_BLOCK_PREFIX = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]*)?(?:\[[ xX]\][ \t]*)?$/;

function removeRange(markdown: string, start: number, end: number): string {
  let from = start;
  let to = end;
  const linePrefix = markdown.slice(markdown.lastIndexOf("\n", from - 1) + 1, from);
  const before = /[ \t]+$/.exec(linePrefix)?.[0].length ?? 0;
  const after = /^[ \t]+/.exec(markdown.slice(to))?.[0].length ?? 0;
  // Never eat the space after a list or quote marker; take the trailing gap instead.
  if (before > 0 && !ONLY_BLOCK_PREFIX.test(linePrefix)) from -= before;
  else if (after > 0) to += after;
  let next = markdown.slice(0, from) + markdown.slice(to);

  // Drop a line the removal left empty (or holding only a list/quote marker).
  const lineStart = next.lastIndexOf("\n", from - 1) + 1;
  const newline = next.indexOf("\n", from);
  const lineEnd = newline === -1 ? next.length : newline;
  if (ONLY_BLOCK_PREFIX.test(next.slice(lineStart, lineEnd))) {
    if (newline !== -1) next = next.slice(0, lineStart) + next.slice(lineEnd + 1);
    else next = next.slice(0, Math.max(0, lineStart - 1));
    // Keep at most one blank line where a whole paragraph disappeared.
    const at = Math.min(lineStart, next.length);
    const gapStart = next.slice(0, at).search(/\n*$/);
    const gapEnd = at + (/^\n*/.exec(next.slice(at))?.[0].length ?? 0);
    if (gapEnd - gapStart > 2) next = next.slice(0, gapStart) + "\n\n" + next.slice(gapEnd);
  }
  return next;
}

/**
 * Resolve the nth rendered unsourced tag. "keep" removes only the token, so the
 * sentence stays as ordinary text. "delete" removes the claim sentence that
 * carries the token (with the token). Table rows are removed whole. Returns
 * null when the occurrence does not exist.
 */
export function resolveUnsourcedClaim(
  markdown: string,
  occurrence: number,
  action: UnsourcedResolution,
): string | null {
  const offsets = unsourcedTokenOffsets(markdown);
  const at = offsets[occurrence];
  if (at === undefined) return null;
  if (action === "keep") return removeRange(markdown, at, at + UNSOURCED_TOKEN.length);

  const claim = claimSentences(markdown).find((candidate) => candidate.start <= at && at < candidate.end);
  if (!claim) return removeRange(markdown, at, at + UNSOURCED_TOKEN.length);
  if (claim.kind === "tableRow") {
    const lineStart = markdown.lastIndexOf("\n", claim.start - 1) + 1;
    const newline = markdown.indexOf("\n", claim.end);
    return removeRange(markdown, lineStart, newline === -1 ? markdown.length : newline);
  }
  return removeRange(markdown, claim.start, claim.end);
}

type CitedViewLike = { contentJson: unknown; generationRunId?: string | null } | null | undefined;

/**
 * Which citation source list a study mode's chips resolve against. Locked In
 * and Summary use their own stored list. Test Me and Carded borrow the list of
 * the Locked In or Summary row from the same generation run; a stale mode with
 * no matching row gets null (unavailable) rather than a list that may point at
 * different uploads. Legacy rows without run ids fall back to Locked In, then Summary.
 */
export function citationSourcesForMode(
  views: { locked_in: CitedViewLike; summary: CitedViewLike; test_me: CitedViewLike; carded: CitedViewLike; staleKinds?: string[] },
  kind: "locked_in" | "summary" | "test_me" | "carded",
): CitationSourceRef[] | null {
  const own = (view: CitedViewLike) => readStudyDocumentMeta(view?.contentJson)?.citationSources ?? null;
  if (kind === "locked_in" || kind === "summary") return own(views[kind]);
  const runId = views[kind]?.generationRunId;
  if (runId) {
    for (const upstream of [views.locked_in, views.summary]) {
      if (upstream?.generationRunId === runId && own(upstream)) return own(upstream);
    }
  }
  if (views.staleKinds?.includes(kind)) return null;
  return own(views.locked_in) ?? own(views.summary);
}

/** Text with every unsourced token and the space before it removed. */
function withoutUnsourcedTokens(text: string): string {
  return text.split(` ${UNSOURCED_TOKEN}`).join("").split(UNSOURCED_TOKEN).join("");
}

/**
 * True when `after` differs from `before` only by removed unsourced tokens,
 * as when a reader keeps a flagged sentence. Such a save changes no study
 * content, so downstream modes are not out of date.
 */
/**
 * True when the two texts differ only in unsourced tokens, in either direction.
 * Only a server-side re-check may add tokens without it counting as an edit.
 */
export function differsOnlyInUnsourcedTokens(before: string, after: string): boolean {
  return before !== after && withoutUnsourcedTokens(before) === withoutUnsourcedTokens(after);
}

export function isUnsourcedMarkerOnlyChange(before: string, after: string): boolean {
  if (before === after) return false;
  const tokens = (text: string) => text.split(UNSOURCED_TOKEN).length - 1;
  return tokens(after) < tokens(before)
    && withoutUnsourcedTokens(before) === withoutUnsourcedTokens(after);
}
