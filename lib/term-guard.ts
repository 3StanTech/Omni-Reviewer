/**
 * Term guard: a deterministic check that a sentence judged supported does not
 * add specific terms (names, abbreviations, numbers, drug and disease words)
 * that appear nowhere in the source text. Free and model-independent; the
 * verifier has approved sentences whose main claim matched but whose added
 * details did not.
 */

import { citationPattern, UNSOURCED_TOKEN } from "@/lib/citations";

/**
 * Normalized source texts (joined with " | ", padded with spaces), their word
 * set, and every run of 2 to 4 adjacent words of 2+ characters written as one
 * ("dsb sc" as "dsbsc"), so a hyphen or space variant of a term still matches.
 */
export type SourceVocabulary = { text: string; words: ReadonlySet<string>; joined: ReadonlySet<string> };

const MAX_JOINED_WORDS = 4;

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
  const joined = new Set<string>();
  for (const text of normalized) {
    const words = text.split(" ").filter(Boolean);
    words.forEach((_, start) => {
      let run = "";
      for (let end = start; end < words.length && end < start + MAX_JOINED_WORDS && words[end].length >= 2; end++) {
        run += words[end];
        if (end > start) joined.add(run);
      }
    });
  }
  return {
    text: ` ${normalized.join(" | ")} `,
    words: new Set(normalized.flatMap((text) => text.split(" ")).filter(Boolean)),
    joined,
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

const LIST_OR_QUOTE_PREFIX = /^\s*(?:>\s?)*\s*(?:(?:[-*+]|\d{1,3}[.)]|[a-zA-Z][.)])\s+(?:\[[ xX]\]\s+)?)?/;

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

/** A specific term and the hyphenated words it was split from; standalone when it also occurs on its own. */
type FoundTerm = { term: string; standalone: boolean; compounds: string[] };

/**
 * Specific terms in a sentence, in first-seen order, deduplicated by their
 * normalized form and reported with their original casing.
 */
export function specificTerms(sentence: string): string[] {
  return findTerms(sentence).map((found) => found.term);
}

function findTerms(sentence: string): FoundTerm[] {
  const text = canonicalizeGreek(
    sentence.split(UNSOURCED_TOKEN).join(" ").replace(citationPattern(), " ").replace(LIST_OR_QUOTE_PREFIX, ""),
  );
  const found: FoundTerm[] = [];
  const seen = new Map<string, FoundTerm>();
  const add = (term: string, compound?: string) => {
    const key = normalize(term);
    if (!key) return;
    let entry = seen.get(key);
    if (!entry) {
      entry = { term, standalone: false, compounds: [] };
      seen.set(key, entry);
      found.push(entry);
    }
    if (compound === undefined) entry.standalone = true;
    else if (!entry.compounds.includes(compound)) entry.compounds.push(compound);
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
      const whole = (!inLabel && /\p{N}/u.test(word)) || abbreviated || hasMedicalSuffix(word);
      if (whole) add(word);
      const specificParts = parts.map(
        (part, index) => !isRomanNumeral(part) && !isAllowlisted(part) && specificWord(part, atBoundary && index === 0, inLabel),
      );
      // Ordinary parts of 4+ letters count only beside a specific one ("calcium" of
      // "calcium-dependent"), never in a compound of ordinary words ("peptide-chain").
      const specificCompound = whole || specificParts.some(Boolean);
      parts.forEach((part, index) => {
        const letters = part.replace(/[^\p{L}]/gu, "");
        if (isRomanNumeral(part) || isAllowlisted(part)) return;
        if (specificParts[index] || (specificCompound && letters.length >= 4)) add(part, word);
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

/** Letters and digits of a term run together ("DSB-SC" and "DSB SC" as "dsbsc"). */
function joinedForm(term: string): string {
  return normalize(term).replace(/ /g, "");
}

/** The term (4+ characters, with a letter) written as one word, matched against a source word or a source run of words written as one. */
function joinedPresent(term: string, vocab: SourceVocabulary): boolean {
  const joined = joinedForm(term);
  return joined.length >= 4 && /\p{L}/u.test(joined) && (vocab.words.has(joined) || vocab.joined.has(joined));
}

function termPresent(term: string, vocab: SourceVocabulary): boolean {
  return exactTermPresent(term, vocab) || joinedPresent(term, vocab);
}

function exactTermPresent(term: string, vocab: SourceVocabulary): boolean {
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

/**
 * An acronym of 3+ letters ("PJP") that the sentence spells out as adjacent
 * words with its initials ("Pneumocystis jiroveci pneumonia"), where the
 * source also has that phrase. Initials alone are not matched across the
 * source, where some run of words shares almost any short acronym's initials.
 */
function expansionPresent(acronym: string, sentence: string, vocab: SourceVocabulary): boolean {
  if (!/^\p{Lu}{3,}$/u.test(acronym)) return false;
  const initials = acronym.toLowerCase();
  const words = normalize(canonicalizeGreek(sentence.replace(citationPattern(), " "))).split(" ").filter(Boolean);
  for (let start = 0; start + initials.length <= words.length; start++) {
    const run = words.slice(start, start + initials.length);
    if (run.every((word, index) => word[0] === initials[index] && word !== initials) && termPresent(run.join(" "), vocab)) return true;
  }
  return false;
}

/**
 * Specific terms of the sentence that the source text never mentions. A part
 * of a hyphenated word ("SC" of "DSB-SC") is not reported on its own when the
 * whole word is present.
 */
export function absentTerms(sentence: string, vocab: SourceVocabulary): string[] {
  return findTerms(sentence)
    .filter(({ term, standalone, compounds }) => {
      if (termPresent(term, vocab) || expansionPresent(term, sentence, vocab)) return false;
      return standalone || !compounds.some((compound) => termPresent(compound, vocab));
    })
    .map(({ term }) => term);
}
