/**
 * Hybrid grounding check for generated study Markdown.
 *
 * Every claim sentence is scored lexically against the source pages it cites
 * (or every page when it cites nothing usable). Lexical misses go to one
 * batched `verify` call; anything still unsupported gets `[[unsourced]]`
 * inserted after it. Apart from those insertions the Markdown is unchanged.
 */

import {
  citationPattern,
  isSentenceAbbreviation,
  parseCitations,
  stripCitations,
  UNSOURCED_TOKEN,
  type Citation,
} from "@/lib/citations";
import { splitPages } from "@/lib/source-markers";

export const LEXICAL_SUPPORT_THRESHOLD = 0.55;

const MIN_CLAIM_WORDS = 6;

export type GroundingSource = {
  /** 1-based index, as cited with S<n>. */
  index: number;
  /** Source text; may contain `<<<page N>>>` marker lines. */
  text: string;
};

export type VerifyItem = { id: number; sentence: string; evidence: string };

export type VerifyFn = (items: VerifyItem[]) => Promise<Array<{ id: number; supported: boolean }>>;

export type GroundingReport = {
  total: number;
  cited: number;
  lexicalSupported: number;
  verifiedSupported: number;
  unsourced: number;
  truncated: boolean;
  verifierFailed: boolean;
};

// ---------------------------------------------------------------------------
// Lexical matching

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for", "with", "from", "as",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those",
  "which", "who", "whom", "than", "then", "into", "also", "can", "may", "such", "their", "there",
  "they", "has", "have", "had", "do", "does", "did", "will", "would", "should", "could", "if", "when",
  "while", "so", "both", "each", "all", "any", "more", "most", "other", "some", "very", "via",
]);

const UNSOURCED_PATTERN = /\[\[unsourced\]\]/g;

/** Lowercased, diacritic-free, citation-free content words joined by single spaces. */
export function normalizeForMatch(text: string): string {
  return text
    .replace(UNSOURCED_PATTERN, " ")
    .replace(citationPattern(), " ")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token && !STOPWORDS.has(token))
    .join(" ");
}

function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

function stemmedTokens(normalized: string): string[] {
  return normalized ? normalized.split(" ").map(stem) : [];
}

const NUMBER_WITH_UNIT = /\d+(?:[.,]\d+)?(?:\s?(?:%|[A-Za-zµμ]{1,5}(?:\/[A-Za-z]{1,4})?)(?![\p{L}\p{N}]))?/gu;

/** Distinctive terms a supporting page should contain: names, numbers with units, long words. */
export function keyTerms(sentence: string): string[] {
  const text = sentence.replace(UNSOURCED_PATTERN, " ").replace(citationPattern(), " ");
  const raw: string[] = [];

  for (const match of text.matchAll(NUMBER_WITH_UNIT)) raw.push(match[0]);

  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  words.forEach((word, position) => {
    const letters = word.replace(/[^\p{L}]/gu, "");
    const hasDigit = /\p{N}/u.test(word);
    const innerUpper = /\p{Lu}/u.test(word.slice(1));
    const capitalized = position > 0 && /^\p{Lu}/u.test(word);
    if (hasDigit || innerUpper || capitalized || letters.length >= 7) raw.push(word);
  });

  const terms: string[] = [];
  for (const term of raw) {
    const normalized = normalizeForMatch(term);
    if (normalized && !terms.includes(normalized)) terms.push(normalized);
  }
  return terms;
}

type IndexedText = { tokens: Set<string>; joined: string };

function indexText(text: string): IndexedText {
  const tokens = stemmedTokens(normalizeForMatch(text));
  return { tokens: new Set(tokens), joined: ` ${tokens.join(" ")} ` };
}

type SentenceTerms = { key: string[]; content: string[] };

function sentenceTerms(sentence: string): SentenceTerms {
  const key = keyTerms(sentence).map((term) => stemmedTokens(term).join(" "));
  const content = [...new Set(stemmedTokens(normalizeForMatch(sentence)))];
  return { key, content };
}

function scoreTerms(terms: SentenceTerms, candidate: IndexedText): number {
  if (terms.content.length === 0) return 0;
  const contentRecall = terms.content.filter((token) => candidate.tokens.has(token)).length / terms.content.length;
  const keyRecall = terms.key.length
    ? terms.key.filter((term) => candidate.joined.includes(` ${term} `)).length / terms.key.length
    : contentRecall;
  return 0.6 * keyRecall + 0.4 * contentRecall;
}

/** Share of the sentence's key terms and content words found in the candidate, in [0, 1]. */
export function lexicalSupport(sentence: string, candidateText: string): number {
  return scoreTerms(sentenceTerms(sentence), indexText(candidateText));
}

// ---------------------------------------------------------------------------
// Claim extraction

type Claim = {
  line: number;
  /** Offset within the line where the token would be inserted. */
  insertAt: number;
  /** Claim text without citations, for scoring and verification. */
  sentence: string;
  citations: Citation[];
  alreadyUnsourced: boolean;
};

const FILL = "\u0001";
const TRAILING_MARK = new RegExp(String.raw`\s*(?:${citationPattern().source}|\[\[unsourced\]\])$`);
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^[^\]\s]+\]:/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s/;
const INLINE_CODE_OR_MATH = /`+[^`]*`+|\$\$[^$]*\$\$|\$[^$\s][^$]*\$/g;
const LIST_OR_QUOTE_PREFIX = /^\s*(?:>\s?)*\s*(?:(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?)?/;

function blank(match: string): string {
  return FILL.repeat(match.length);
}

/** Hide citations, tokens, inline code, and inline math while keeping offsets. */
function maskLine(line: string): string {
  return line
    .replace(citationPattern(), blank)
    .replace(UNSOURCED_PATTERN, blank)
    .replace(INLINE_CODE_OR_MATH, blank);
}

function wordCount(masked: string): number {
  return (masked.split(FILL).join(" ").match(/\S*[\p{L}\p{N}]\S*/gu) ?? []).length;
}

/** Sentence spans [start, end) within masked[from, to). */
function sentenceSpans(masked: string, from: number, to: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const terminal = /[.!?]+["'”’)\]*_]*/g;
  terminal.lastIndex = from;
  let start = from;
  let match: RegExpExecArray | null;
  while ((match = terminal.exec(masked)) && match.index < to) {
    const end = match.index + match[0].length;
    if (end > to) break;
    let next = end;
    while (next < to && (/\s/.test(masked[next]) || masked[next] === FILL)) next++;
    if (next >= to) break;
    if (next === end) continue;
    if (!/[\p{Lu}\p{N}"'“‘(\[*_]/u.test(masked[next])) continue;
    if (match[0][0] === "." && isSentenceAbbreviation(masked, match.index, from)) continue;
    spans.push([start, next]);
    start = next;
  }
  if (start < to) spans.push([start, to]);
  return spans;
}

/** Offset just before any trailing whitespace, citations, and tokens of line[start, end). */
function insertionPoint(line: string, start: number, end: number): number {
  let text = line.slice(start, end).replace(/\s+$/, "");
  for (;;) {
    const trailing = TRAILING_MARK.exec(text);
    if (!trailing || trailing.index === 0) break;
    text = text.slice(0, trailing.index);
  }
  return start + text.replace(/\s+$/, "").length;
}

function makeClaim(line: string, lineIndex: number, start: number, end: number, insertAt: number, sentenceText: string): Claim {
  const segment = line.slice(start, end);
  return {
    line: lineIndex,
    insertAt,
    sentence: stripCitations(sentenceText).replace(/\s+/g, " ").trim(),
    citations: parseCitations(segment),
    alreadyUnsourced: segment.includes(UNSOURCED_TOKEN),
  };
}

function tableRowClaim(line: string, lineIndex: number): Claim | null {
  const masked = maskLine(line);
  const pipes: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "|" && masked[i - 1] !== "\\") pipes.push(i);
  }
  const cellText = masked.replace(/\|/g, " ");
  if (wordCount(cellText) < MIN_CLAIM_WORDS) return null;

  const bounds: Array<[number, number]> = [];
  for (let i = 0; i < pipes.length; i++) {
    const cellStart = pipes[i] + 1;
    const cellEnd = i + 1 < pipes.length ? pipes[i + 1] : line.replace(/\s+$/, "").length;
    if (cellEnd > cellStart) bounds.push([cellStart, cellEnd]);
  }
  const lastCell = [...bounds].reverse().find(([s, e]) => line.slice(s, e).trim().length > 0);
  if (!lastCell) return null;

  const insertAt = insertionPoint(line, lastCell[0], lastCell[1]);
  const sentence = line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(" | ");
  return makeClaim(line, lineIndex, 0, line.length, insertAt, sentence);
}

function extractClaims(lines: string[]): Claim[] {
  const claims: Claim[] = [];
  let fence: string | null = null;
  let inMathBlock = false;
  let inFootnote = false;
  let previousBlank = false;

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    const wasBlank = previousBlank;
    previousBlank = !trimmed;
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1] === fence) fence = null;
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return;
    }
    if (inMathBlock) {
      if (trimmed.endsWith("$$") || trimmed.endsWith("\\]")) inMathBlock = false;
      return;
    }
    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const closed = trimmed.length > 2 && (trimmed.endsWith("$$") || trimmed.endsWith("\\]"));
      if (!closed) inMathBlock = true;
      return;
    }
    // Footnote definitions and their continuation lines are not rendered, so never mark them.
    if (FOOTNOTE_DEFINITION.test(line)) {
      inFootnote = true;
      return;
    }
    if (inFootnote) {
      if (!trimmed || /^[ \t]/.test(line) || !wasBlank) return;
      inFootnote = false;
    }
    if (!trimmed || /^#{1,6}(\s|$)/.test(trimmed) || trimmed.startsWith("<")) return;
    if (/^(?: {4,}|\t)/.test(line) && !LIST_ITEM.test(line)) return;

    if (trimmed.startsWith("|")) {
      if (TABLE_SEPARATOR.test(line)) return;
      const next = lines[lineIndex + 1];
      if (next !== undefined && next.trim().startsWith("|") && TABLE_SEPARATOR.test(next)) return;
      const claim = tableRowClaim(line, lineIndex);
      if (claim) claims.push(claim);
      return;
    }

    const masked = maskLine(line);
    const contentStart = LIST_OR_QUOTE_PREFIX.exec(line)?.[0].length ?? 0;
    for (const [start, end] of sentenceSpans(masked, contentStart, line.length)) {
      if (wordCount(masked.slice(start, end)) < MIN_CLAIM_WORDS) continue;
      const readable = line.slice(start, end).replace(INLINE_CODE_OR_MATH, " ");
      claims.push(makeClaim(line, lineIndex, start, end, insertionPoint(line, start, end), readable));
    }
  });

  return claims;
}

// ---------------------------------------------------------------------------
// Evidence

type EvidencePage = { key: string; page: number; text: string; index: IndexedText };

function buildPages(sources: GroundingSource[]): Map<number, EvidencePage[]> {
  const bySource = new Map<number, EvidencePage[]>();
  for (const source of sources) {
    const pages = splitPages(source.text)
      .filter((page) => page.text)
      .map((page) => ({ key: `${source.index}:${page.page}`, text: page.text, index: indexText(page.text), page: page.page }));
    bySource.set(source.index, pages);
  }
  return bySource;
}

function evidencePagesFor(claim: Claim, bySource: Map<number, EvidencePage[]>, allPages: EvidencePage[]): EvidencePage[] {
  if (claim.citations.length === 0) return allPages;
  const chosen = new Map<string, EvidencePage>();
  for (const citation of claim.citations) {
    const pages = bySource.get(citation.source);
    if (!pages || pages.length === 0) return allPages;
    const { pageStart, pageEnd } = citation;
    const matched =
      pageStart === null ? pages : pages.filter((page) => page.page >= pageStart && page.page <= (pageEnd ?? pageStart));
    if (matched.length === 0) return allPages;
    for (const page of matched) chosen.set(page.key, page);
  }
  return [...chosen.values()];
}

function isVerifyResult(value: unknown): value is Array<{ id: number; supported: boolean }> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "number" &&
        typeof (entry as { supported?: unknown }).supported === "boolean",
    )
  );
}

// ---------------------------------------------------------------------------
// Entry point

export async function groundDocument({
  markdown,
  sources,
  verify,
  maxVerifyItems = 60,
  maxEvidenceChars = 4000,
}: {
  markdown: string;
  sources: GroundingSource[];
  verify: VerifyFn;
  maxVerifyItems?: number;
  maxEvidenceChars?: number;
}): Promise<{ markdown: string; report: GroundingReport }> {
  const lines = markdown.split("\n");
  const claims = extractClaims(lines);
  const bySource = buildPages(sources);
  const allPages = [...bySource.values()].flat();

  const report: GroundingReport = {
    total: claims.length,
    cited: claims.filter((claim) => claim.citations.length > 0).length,
    lexicalSupported: 0,
    verifiedSupported: 0,
    unsourced: 0,
    truncated: false,
    verifierFailed: false,
  };

  const toMark: Claim[] = [];
  const misses: Array<{ claim: Claim; best: Array<{ page: EvidencePage; score: number }> }> = [];

  for (const claim of claims) {
    if (claim.alreadyUnsourced) {
      report.unsourced++;
      continue;
    }
    const terms = sentenceTerms(claim.sentence);
    const scored = evidencePagesFor(claim, bySource, allPages)
      .map((page) => ({ page, score: scoreTerms(terms, page.index) }))
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0 && scored[0].score >= LEXICAL_SUPPORT_THRESHOLD) {
      report.lexicalSupported++;
    } else {
      misses.push({ claim, best: scored.slice(0, 2).filter((entry, rank) => rank === 0 || entry.score > 0) });
    }
  }

  const verifiable = misses.slice(0, Math.max(0, maxVerifyItems));
  const overflow = misses.slice(verifiable.length);
  if (overflow.length > 0) {
    report.truncated = true;
    toMark.push(...overflow.map((miss) => miss.claim));
  }

  if (verifiable.length > 0) {
    const items: VerifyItem[] = verifiable.map((miss, id) => ({
      id,
      sentence: miss.claim.sentence,
      evidence: miss.best.map((entry) => entry.page.text).join("\n\n").slice(0, maxEvidenceChars),
    }));
    let supported: Set<number> | null = null;
    try {
      const result: unknown = await verify(items);
      if (isVerifyResult(result)) {
        supported = new Set(result.filter((entry) => entry.supported).map((entry) => entry.id));
      }
    } catch {
      supported = null;
    }
    if (supported === null) report.verifierFailed = true;
    verifiable.forEach((miss, id) => {
      if (supported?.has(id)) report.verifiedSupported++;
      else toMark.push(miss.claim);
    });
  }

  report.unsourced += toMark.length;

  const insertions = new Map<number, number[]>();
  for (const claim of toMark) {
    const offsets = insertions.get(claim.line) ?? [];
    offsets.push(claim.insertAt);
    insertions.set(claim.line, offsets);
  }
  for (const [lineIndex, offsets] of insertions) {
    let line = lines[lineIndex];
    for (const offset of [...offsets].sort((a, b) => b - a)) {
      line = `${line.slice(0, offset)} ${UNSOURCED_TOKEN}${line.slice(offset)}`;
    }
    lines[lineIndex] = line;
  }

  return { markdown: lines.join("\n"), report };
}
