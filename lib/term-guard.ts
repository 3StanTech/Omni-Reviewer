/**
 * Term guard: a deterministic check that a sentence judged supported does not
 * add specific terms (names, abbreviations, numbers, drug and disease words)
 * that appear nowhere in the source text. Free and model-independent; the
 * verifier has approved sentences whose main claim matched but whose added
 * details did not.
 */

import { citationPattern, UNSOURCED_TOKEN } from "@/lib/citations";

/** Normalized source texts (joined with " | ", padded with spaces) plus their word set. */
export type SourceVocabulary = { text: string; words: ReadonlySet<string> };

const GREEK_NAMES: Record<string, string> = { α: "alpha", β: "beta", γ: "gamma", δ: "delta", κ: "kappa", μ: "mu", µ: "mu" };
const GREEK_GLYPH = /[αβγδκμµ]/g;
const GREEK_LATEX = /\$?\\(alpha|beta|gamma|delta|kappa|mu)(?![a-z])\$?/g;

/** Greek letters as glyphs ("β") or LaTeX ("$\\beta$", "\\beta") become their spelled names ("beta"). */
function canonicalizeGreek(text: string): string {
  return text.replace(GREEK_LATEX, "$1").replace(GREEK_GLYPH, (glyph) => GREEK_NAMES[glyph]);
}

/** Lowercase, strip diacritics, turn punctuation into spaces, and collapse whitespace. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Each text normalized on its own and joined with " | ", so no phrase matches across two texts. */
export function buildSourceVocabulary(texts: readonly string[]): SourceVocabulary {
  const normalized = texts.map((text) => normalize(canonicalizeGreek(text)));
  return {
    text: ` ${normalized.join(" | ")} `,
    words: new Set(normalized.flatMap((text) => text.split(" ")).filter(Boolean)),
  };
}

const ALLOWLIST = new Set(["gram", "table", "figure", "note", "example", "type", "class"]);

const MEDICAL_SUFFIXES = [
  "emia", "itis", "osis", "ase", "mycin", "cillin", "cycline", "azole", "floxacin", "vir", "cide", "penem", "dependent",
];

/** Everyday words that happen to end in a medical suffix. */
const COMMON_SUFFIX_WORDS = new Set([
  "base", "case", "ease", "phase", "phrase", "chase", "vase", "lease", "erase", "please", "release", "increase",
  "decrease", "disease", "purchase", "database", "showcase", "decide", "coincide",
]);

const ROMAN_NUMERAL = /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

/** `*x*` or `_x_` that is not part of `**bold**` / `__bold__`. */
const ITALIC_SPAN = /(?<![*\p{L}\p{N}])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![*\p{L}\p{N}])|(?<![_\p{L}\p{N}])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![_\p{L}\p{N}])/gu;

/**
 * A leading emphasized lead-in ending in a colon ("**Clinical Utility:**",
 * "*Q1:*"): a title-cased label, so its capitals and numbering are not terms.
 */
const LEAD_IN_LABEL = /^\s*(\*\*|__|\*|_)[^*_\n]+?(?::\1|\1:)/;

const LIST_OR_QUOTE_PREFIX = /^\s*(?:>\s?)*\s*(?:(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?)?/;

/** A word (inner hyphens, apostrophes and dots between letters or digits kept) or a boundary mark. */
const TOKEN = /[\p{L}\p{N}]+(?:[-'’.][\p{L}\p{N}]+)*|[|:.!?\n]/gu;

function isRomanNumeral(word: string): boolean {
  return word.length > 0 && ROMAN_NUMERAL.test(word);
}

function isAllowlisted(word: string): boolean {
  return ALLOWLIST.has(word.toLowerCase());
}

/** A token with a digit, or an all-caps abbreviation of 2+ letters: it must match as a whole token. */
function isExactToken(word: string): boolean {
  if (/\p{N}/u.test(word)) return true;
  const letters = word.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

function hasMedicalSuffix(word: string): boolean {
  const lower = word.toLowerCase();
  const singular = lower.endsWith("s") ? lower.slice(0, -1) : lower;
  return [lower, singular].some(
    (form) => !COMMON_SUFFIX_WORDS.has(form) && MEDICAL_SUFFIXES.some((suffix) => form.length > suffix.length + 1 && form.endsWith(suffix)),
  );
}

/** Whether a single word (no hyphen) is specific on its own; a lead-in label word counts only as an abbreviation or medical word. */
function specificWord(word: string, atBoundary: boolean, inLabel = false): boolean {
  if (isRomanNumeral(word) || isAllowlisted(word)) return false;
  const letters = word.replace(/[^\p{L}]/gu, "");
  if (inLabel) atBoundary = true;
  else if (/\p{N}/u.test(word)) return true;
  if (letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return true;
  if (!atBoundary && letters.length >= 2 && /^\p{Lu}/u.test(word)) return true;
  return hasMedicalSuffix(word);
}

/**
 * Specific terms in a sentence, in first-seen order, deduplicated by their
 * normalized form and reported with their original casing.
 */
export function specificTerms(sentence: string): string[] {
  const text = canonicalizeGreek(
    sentence.split(UNSOURCED_TOKEN).join(" ").replace(citationPattern(), " ").replace(LIST_OR_QUOTE_PREFIX, ""),
  );
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (term: string) => {
    const key = normalize(term);
    if (!key || seen.has(key)) return;
    seen.add(key);
    found.push(term);
  };

  const labelEnd = LEAD_IN_LABEL.exec(text)?.[0].length ?? 0;

  for (const match of text.matchAll(ITALIC_SPAN)) {
    if ((match.index ?? 0) < labelEnd) continue;
    const span = (match[1] ?? match[2]).trim();
    if (span && !isRomanNumeral(span) && !isAllowlisted(span)) add(span);
  }

  // Same length as `text`, so token offsets still locate the lead-in label.
  const plain = text.replace(/[*_]/g, " ");
  let atBoundary = true;
  for (const match of plain.matchAll(TOKEN)) {
    const token = match[0];
    const inLabel = (match.index ?? 0) < labelEnd;
    if (/^[|:.!?\n]$/.test(token)) {
      atBoundary = true;
      continue;
    }
    const word = token.replace(/[.'’]+$/, "");
    if (word.includes("-")) {
      const parts = word.split("-").filter(Boolean);
      // The whole compound counts for a digit ("IL-6"), an abbreviation ("TMP-SMX") or a medical suffix ("calcium-dependent").
      const abbreviated = parts.some((part) => !/\p{N}/u.test(part) && isExactToken(part));
      if ((!inLabel && /\p{N}/u.test(word)) || abbreviated || hasMedicalSuffix(word)) add(word);
      parts.forEach((part, index) => {
        const letters = part.replace(/[^\p{L}]/gu, "");
        if (isRomanNumeral(part) || isAllowlisted(part)) return;
        if (letters.length >= 4 || specificWord(part, atBoundary && index === 0, inLabel)) add(part);
      });
    } else if (specificWord(word, atBoundary, inLabel)) {
      add(word);
    }
    atBoundary = false;
  }
  return found;
}

/**
 * A normalized ordinary word found at a word start: as is, singular, or by a
 * 6-letter prefix when over 8 letters. Numbers and abbreviations need the whole token.
 */
function wordPresent(word: string, vocab: SourceVocabulary, exact = false): boolean {
  if (vocab.words.has(word)) return true;
  if (exact) return false;
  const forms = [word];
  if (word.endsWith("es") && word.length > 4) forms.push(word.slice(0, -2));
  if (word.endsWith("s") && word.length > 3) forms.push(word.slice(0, -1));
  if (/^\p{L}+$/u.test(word) && word.length > 8) forms.push(word.slice(0, 6));
  return forms.some((form) => vocab.text.includes(` ${form}`));
}

function singular(word: string): string {
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

/** "E. coli": a one-letter genus initial followed by the species. */
const ABBREVIATED_GENUS = /^\p{Lu}\.?\s+\p{L}/u;

function termPresent(term: string, vocab: SourceVocabulary): boolean {
  const original = term
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (original.length === 0) return true;
  const words = original.map((word) => normalize(word));
  const exact = original.map(isExactToken);
  if (words.length === 1) return wordPresent(words[0], vocab, exact[0]);
  // The species with its genus initial, as "e coli" or "escherichia coli".
  if (words[0].length === 1 && ABBREVIATED_GENUS.test(term.trim())) {
    return new RegExp(` ${words[0]}\\p{L}* ${words.slice(1).join(" ")} `, "u").test(vocab.text);
  }
  if (vocab.text.includes(` ${words.join(" ")} `)) return true;
  // A compound with a number or abbreviation ("IL-6-dependent") only matches as a
  // whole; its ordinary words may differ in number ("6-month" and "6 months").
  if (exact.some(Boolean)) {
    const phrase = words.map((word, index) => (exact[index] ? word : `(?:${singular(word)}|${word})(?:e?s)?`)).join(" ");
    return new RegExp(` ${phrase} `, "u").test(vocab.text);
  }
  const long = words.filter((word) => word.length >= 4);
  return long.length > 0 && long.every((word) => wordPresent(word, vocab));
}

/** Specific terms of the sentence that the source text never mentions. */
export function absentTerms(sentence: string, vocab: SourceVocabulary): string[] {
  return specificTerms(sentence).filter((term) => !termPresent(term, vocab));
}
