/**
 * Hybrid grounding check for generated study Markdown.
 *
 * Every claim sentence is scored lexically against the source pages it cites
 * (or every page when it cites nothing usable; an uncited table row borrows
 * its table's citation). Lexical misses go to one batched `verify` call with
 * the most relevant passages of their best pages; anything still unsupported
 * gets `[[unsourced]]` inserted after it. Misses beyond the batch stay
 * untagged and count as unchecked. A claim judged supported is still tagged
 * when the term guard finds a specific term absent from every source. Apart
 * from those insertions the Markdown is unchanged.
 */

import {
  citationPattern,
  isSentenceAbbreviation,
  parseCitations,
  stripCitations,
  UNSOURCED_TOKEN,
  type Citation,
} from "@/lib/citations";
import { canonicalizeLatex } from "@/lib/latex-text";
import { GROUNDING_PASSAGE_CHARS } from "@/lib/learning-limits";
import { splitPages } from "@/lib/source-markers";
import { absentTerms, buildSourceVocabulary } from "@/lib/term-guard";

export const LEXICAL_SUPPORT_THRESHOLD = 0.55;

/** Overlap between neighbouring evidence windows, so a sentence is never cut in every window. */
const PASSAGE_OVERLAP_CHARS = 150;
const PASSAGE_SEPARATOR = "\n...\n";
/** Non-blank lines above a table searched for a caption or lead-in citation. */
const TABLE_CAPTION_LOOKBACK = 3;

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
  /** Untagged claims left unchecked because the verifier failed twice or the batch was full. */
  unchecked?: number;
  /** claimKey of each of those unchecked claims, so Check again can find them. */
  uncheckedKeys?: string[];
  /** Claims judged supported but tagged because a specific term is absent from the sources; included in unsourced. */
  termFlagged?: number;
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

function withoutMarks(text: string): string {
  return text.replace(UNSOURCED_PATTERN, " ").replace(citationPattern(), " ");
}

/** Lowercased, diacritic-free content words joined by single spaces; LaTeX left as markup. */
function contentWords(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token && !STOPWORDS.has(token))
    .join(" ");
}

/** Lowercased, diacritic-free, citation-free content words joined by single spaces, LaTeX read as plain words. */
export function normalizeForMatch(text: string): string {
  return contentWords(canonicalizeLatex(withoutMarks(text)));
}

/**
 * Stable 8-hex id of a claim: FNV-1a (32-bit) over the UTF-8 of its normalized
 * text. Deliberately without the LaTeX rewrite of normalizeForMatch, so keys
 * stored by earlier runs still match; callers pass the claim's key text.
 */
export function claimKey(sentence: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(contentWords(withoutMarks(sentence)))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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
  const text = canonicalizeLatex(withoutMarks(sentence));
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

/**
 * A claim scores as the better of its forms: with its inline math, so a
 * formula sentence keeps its numbers and units, and without it, as earlier
 * runs read it, so math the page writes differently never costs a match.
 */
function scoreForms(forms: SentenceTerms[], candidate: IndexedText): number {
  return Math.max(...forms.map((terms) => scoreTerms(terms, candidate)));
}

function claimForms(claim: Claim): SentenceTerms[] {
  const withMath = sentenceTerms(claim.sentence);
  return claim.keyText === claim.sentence ? [withMath] : [withMath, sentenceTerms(claim.keyText)];
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
  /** End of the claim's span in the line, including trailing citations. */
  end: number;
  /** Claim text without citations or inline code, inline math kept, for scoring and verification. */
  sentence: string;
  /**
   * The claim text as earlier runs read it: prose sentences without inline code
   * or math (table rows keep theirs). Feeds claimKey, so stored keys still
   * match, and the term guard, whose input this change leaves alone.
   */
  keyText: string;
  citations: Citation[];
  /** A table's caption or header citations, for an uncited row's evidence pages only. */
  inheritedCitations: Citation[];
  alreadyUnsourced: boolean;
};

const FILL = "\u0001";
const TRAILING_MARK = new RegExp(String.raw`\s*(?:${citationPattern().source}|\[\[unsourced\]\])$`);
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^[^\]\s]+\]:/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s/;
const INLINE_CODE_OR_MATH = /`+[^`]*`+|\$\$[^$]*\$\$|\$[^$\s][^$]*\$/g;
const INLINE_CODE = /`+[^`]*`+/g;
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

function claimText(text: string): string {
  return stripCitations(text).replace(/\s+/g, " ").trim();
}

function makeClaim(
  line: string,
  lineIndex: number,
  start: number,
  end: number,
  insertAt: number,
  sentenceText: string,
  keyText = sentenceText,
): Claim {
  const segment = line.slice(start, end);
  return {
    line: lineIndex,
    insertAt,
    end,
    sentence: claimText(sentenceText),
    keyText: claimText(keyText),
    citations: parseCitations(segment),
    inheritedCitations: [],
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

/**
 * Citations an uncited row borrows from its table: the nearest cited line in
 * the few non-blank lines above the table (a heading, caption or lead-in),
 * else the header row. Never written into the Markdown.
 */
function tableCitations(lines: string[], tableStart: number): Citation[] {
  let seen = 0;
  for (let i = tableStart - 1; i >= 0 && seen < TABLE_CAPTION_LOOKBACK; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("|")) break;
    seen++;
    const citations = parseCitations(lines[i]);
    if (citations.length > 0) return citations;
  }
  const next = lines[tableStart + 1];
  const hasHeader = next !== undefined && next.trim().startsWith("|") && TABLE_SEPARATOR.test(next);
  return hasHeader ? parseCitations(lines[tableStart]) : [];
}

function extractClaims(lines: string[]): Claim[] {
  const claims: Claim[] = [];
  let fence: string | null = null;
  let inMathBlock = false;
  let inFootnote = false;
  let previousBlank = false;
  let tableStart = 0;

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
      if (lineIndex === 0 || !lines[lineIndex - 1].trim().startsWith("|")) tableStart = lineIndex;
      if (TABLE_SEPARATOR.test(line)) return;
      const next = lines[lineIndex + 1];
      if (next !== undefined && next.trim().startsWith("|") && TABLE_SEPARATOR.test(next)) return;
      const claim = tableRowClaim(line, lineIndex);
      if (claim) {
        if (claim.citations.length === 0) claim.inheritedCitations = tableCitations(lines, tableStart);
        claims.push(claim);
      }
      return;
    }

    const masked = maskLine(line);
    const contentStart = LIST_OR_QUOTE_PREFIX.exec(line)?.[0].length ?? 0;
    for (const [start, end] of sentenceSpans(masked, contentStart, line.length)) {
      if (wordCount(masked.slice(start, end)) < MIN_CLAIM_WORDS) continue;
      const text = line.slice(start, end);
      const withMath = text.replace(INLINE_CODE, " ");
      const withoutMath = text.replace(INLINE_CODE_OR_MATH, " ");
      claims.push(makeClaim(line, lineIndex, start, end, insertionPoint(line, start, end), withMath, withoutMath));
    }
  });

  return claims;
}

/**
 * Each claim's verifier sentence and the text its term guard reads, in
 * document order, for local replay tooling. Unsourced tokens are not stripped.
 */
export function groundingClaimTexts(markdown: string): Array<{ sentence: string; termGuardText: string }> {
  return extractClaims(markdown.split("\n")).map((claim) => ({ sentence: claim.sentence, termGuardText: claim.keyText }));
}

// ---------------------------------------------------------------------------
// Evidence

type EvidencePage = { key: string; source: number; page: number; text: string; index: IndexedText };

function buildPages(sources: GroundingSource[]): Map<number, EvidencePage[]> {
  const bySource = new Map<number, EvidencePage[]>();
  for (const source of sources) {
    const pages = splitPages(source.text)
      .filter((page) => page.text)
      .map((page) => ({
        key: `${source.index}:${page.page}`,
        source: source.index,
        page: page.page,
        text: page.text,
        index: indexText(page.text),
      }));
    bySource.set(source.index, pages);
  }
  return bySource;
}

function evidencePagesFor(claim: Claim, bySource: Map<number, EvidencePage[]>, allPages: EvidencePage[]): EvidencePage[] {
  const citations = claim.citations.length > 0 ? claim.citations : claim.inheritedCitations;
  if (citations.length === 0) return allPages;
  const chosen = new Map<string, EvidencePage>();
  for (const citation of citations) {
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

/** Overlapping windows of `size` characters; the last one ends at the page end. */
function pageWindows(text: string, size: number): Array<{ start: number; text: string }> {
  if (text.length <= size) return [{ start: 0, text }];
  const step = Math.max(1, size - Math.min(PASSAGE_OVERLAP_CHARS, Math.floor(size / 2)));
  const windows: Array<{ start: number; text: string }> = [];
  for (let start = 0; start + size < text.length; start += step) {
    windows.push({ start, text: text.slice(start, start + size) });
  }
  const last = text.length - size;
  windows.push({ start: last, text: text.slice(last) });
  return windows;
}

/**
 * The claim's most relevant passages from its best pages, highest score first
 * until the budget is full, then printed in page and position order. A dense
 * page no longer loses its supporting text to a fixed prefix cut.
 */
function passageEvidence(terms: SentenceTerms[], pages: EvidencePage[], maxChars: number, passageChars: number): string {
  const size = Math.max(1, Math.min(passageChars, maxChars));
  const windows = pages.flatMap((page, rank) =>
    pageWindows(page.text, size).map((window) => ({
      page,
      rank,
      start: window.start,
      text: window.text,
      score: scoreForms(terms, indexText(window.text)),
    })),
  );
  windows.sort((a, b) => b.score - a.score || a.rank - b.rank || a.start - b.start);

  const picked: typeof windows = [];
  let length = 0;
  for (const window of windows) {
    const added = (picked.length > 0 ? PASSAGE_SEPARATOR.length : 0) + window.text.length;
    if (length + added > maxChars) break;
    picked.push(window);
    length += added;
  }
  picked.sort((a, b) => a.page.source - b.page.source || a.page.page - b.page.page || a.start - b.start);
  return picked.map((window) => window.text).join(PASSAGE_SEPARATOR);
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
// Tokens

type Insertion = { line: number; at: number; text: string };

const TOKEN_WITH_SPACE = / ?\[\[unsourced\]\]/g;

/** Remove every unsourced token, remembering where each sat in the stripped line. */
function stripTokens(lines: string[]): { lines: string[]; tokens: Insertion[] } {
  const tokens: Insertion[] = [];
  const stripped = lines.map((line, lineIndex) => {
    let out = "";
    let last = 0;
    for (const match of line.matchAll(TOKEN_WITH_SPACE)) {
      out += line.slice(last, match.index);
      tokens.push({ line: lineIndex, at: out.length, text: match[0] });
      last = match.index + match[0].length;
    }
    return out + line.slice(last);
  });
  return { lines: stripped, tokens };
}

/** Insert texts at offsets of their lines; equal offsets keep their given order. */
function applyInsertions(lines: string[], insertions: Insertion[]): void {
  const ordered = [...insertions].sort((a, b) => a.line - b.line || a.at - b.at).reverse();
  for (const { line, at, text } of ordered) {
    lines[line] = `${lines[line].slice(0, at)}${text}${lines[line].slice(at)}`;
  }
}

// ---------------------------------------------------------------------------
// Entry point

type Outcome = "pass" | "reject" | "unchecked";

export type RecheckOptions = {
  /** claimKey of each untagged claim an earlier run could not check. */
  uncheckedKeys?: readonly string[];
  /** Graded before keys were recorded: every untagged lexical miss may be checked. */
  legacyUnchecked?: boolean;
};

export async function groundDocument({
  markdown,
  sources,
  verify,
  maxVerifyItems = 60,
  maxEvidenceChars = 4000,
  passageChars = GROUNDING_PASSAGE_CHARS,
  recheck,
}: {
  markdown: string;
  sources: GroundingSource[];
  verify: VerifyFn;
  maxVerifyItems?: number;
  maxEvidenceChars?: number;
  /** Evidence window size; the best windows of each claim's pages reach the verifier. */
  passageChars?: number;
  /**
   * Check again: re-check tagged claims and the untagged claims recorded as
   * unchecked. No other claim is evaluated, so a kept claim is never re-tagged.
   */
  recheck?: RecheckOptions;
}): Promise<{ markdown: string; report: GroundingReport }> {
  const stripped = recheck ? stripTokens(markdown.split("\n")) : null;
  const lines = stripped?.lines ?? markdown.split("\n");
  const claims = extractClaims(lines);
  const bySource = buildPages(sources);
  const allPages = [...bySource.values()].flat();
  const vocabulary = buildSourceVocabulary(sources.map((source) => source.text));
  /** A supported claim naming a term the sources never mention is treated as unsourced. */
  const termGuarded = (claim: Claim): boolean => absentTerms(claim.keyText, vocabulary).length > 0;

  // Claims whose end carried a token before stripping (re-check only).
  const tokenClaims = new Map<Insertion, Claim>();
  if (stripped) {
    for (const token of stripped.tokens) {
      const claim = claims.find((entry) => entry.line === token.line && entry.insertAt <= token.at && token.at <= entry.end);
      if (claim) tokenClaims.set(token, claim);
    }
  }
  const tagged = new Set(tokenClaims.values());
  const pendingKeys = new Set(recheck?.uncheckedKeys ?? []);
  const legacy = Boolean(recheck?.legacyUnchecked);

  /** Whether this pass evaluates the claim at all, given whether it missed lexically. */
  const considered = (claim: Claim, lexicalMiss: boolean): boolean => {
    if (!recheck) return !claim.alreadyUnsourced;
    if (tagged.has(claim)) return true;
    return legacy ? lexicalMiss : pendingKeys.has(claimKey(claim.keyText));
  };

  let lexicalSupported = 0;
  let verifiedSupported = 0;
  let termFlagged = 0;
  let truncated = false;
  let verifierFailed = false;
  const outcomes = new Map<Claim, Outcome>();
  const misses: Array<{ claim: Claim; terms: SentenceTerms[]; best: EvidencePage[] }> = [];

  for (const claim of claims) {
    // Normal and keyed passes know up front which claims they evaluate; a
    // legacy re-check must score untagged claims first to find the misses.
    if (!legacy && !considered(claim, true)) continue;
    const terms = claimForms(claim);
    const scored = evidencePagesFor(claim, bySource, allPages)
      .map((page) => ({ page, score: scoreForms(terms, page.index) }))
      .sort((a, b) => b.score - a.score);
    const lexicalMiss = !(scored.length > 0 && scored[0].score >= LEXICAL_SUPPORT_THRESHOLD);
    if (!considered(claim, lexicalMiss)) continue;
    if (!lexicalMiss) {
      if (termGuarded(claim)) {
        termFlagged++;
        outcomes.set(claim, "reject");
      } else {
        lexicalSupported++;
        outcomes.set(claim, "pass");
      }
    } else {
      const best = scored.slice(0, 2).filter((entry, rank) => rank === 0 || entry.score > 0);
      misses.push({ claim, terms, best: best.map((entry) => entry.page) });
    }
  }

  // Misses beyond the batch are left unchecked, not tagged: an unchecked claim
  // is not evidence that it is missing from the sources, and Check again can reach it.
  const verifiable = misses.slice(0, Math.max(0, maxVerifyItems));
  for (const miss of misses.slice(verifiable.length)) outcomes.set(miss.claim, "unchecked");
  if (misses.length > verifiable.length) truncated = true;

  if (verifiable.length > 0) {
    const items: VerifyItem[] = verifiable.map((miss, id) => ({
      id,
      sentence: miss.claim.sentence,
      evidence: passageEvidence(miss.terms, miss.best, maxEvidenceChars, passageChars),
    }));
    // One retry: a free verifier often fails transiently. If it still fails,
    // leave these claims untagged and count them as unchecked, because a
    // failed check is not evidence that a claim is missing from the sources.
    let supported: Set<number> | null = null;
    for (let attempt = 0; attempt < 2 && supported === null; attempt++) {
      try {
        const result: unknown = await verify(items);
        if (isVerifyResult(result)) {
          supported = new Set(result.filter((entry) => entry.supported).map((entry) => entry.id));
        }
      } catch {
        supported = null;
      }
    }
    if (supported === null) verifierFailed = true;
    verifiable.forEach((miss, id) => {
      let outcome: Outcome = supported === null ? "unchecked" : supported.has(id) ? "pass" : "reject";
      if (outcome === "pass" && termGuarded(miss.claim)) {
        termFlagged++;
        outcome = "reject";
      }
      if (outcome === "pass") verifiedSupported++;
      outcomes.set(miss.claim, outcome);
    });
  }

  // Only untagged claims can be unchecked; a tagged claim that could not be
  // re-checked keeps its tag.
  const uncheckedKeys = claims
    .filter((claim) => outcomes.get(claim) === "unchecked" && !tagged.has(claim))
    .map((claim) => claimKey(claim.keyText));
  const newTags = claims
    .filter((claim) => outcomes.get(claim) === "reject" && !tagged.has(claim))
    .map((claim) => ({ line: claim.line, at: claim.insertAt, text: ` ${UNSOURCED_TOKEN}` }));

  // Passing tagged claims lose their token; every other token (failing or
  // unchecked tagged claims, tokens on lines that are not claims) goes back
  // exactly where it was.
  const keptTokens = stripped
    ? stripped.tokens.filter((token) => {
        const claim = tokenClaims.get(token);
        return !claim || outcomes.get(claim) !== "pass";
      })
    : [];
  applyInsertions(lines, [...keptTokens, ...newTags]);
  const output = lines.join("\n");

  const report: GroundingReport = {
    total: claims.length,
    cited: claims.filter((claim) => claim.citations.length > 0).length,
    lexicalSupported,
    verifiedSupported,
    unsourced: recheck
      ? output.split(UNSOURCED_TOKEN).length - 1
      : claims.filter((claim) => claim.alreadyUnsourced).length + newTags.length,
    truncated,
    verifierFailed,
  };
  if (uncheckedKeys.length > 0) {
    report.unchecked = uncheckedKeys.length;
    report.uncheckedKeys = uncheckedKeys;
  }
  if (termFlagged > 0) report.termFlagged = termFlagged;

  return { markdown: output, report };
}
