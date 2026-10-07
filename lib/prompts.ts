/** Plain prompt strings for the study-pack generation pipeline. No secrets. */

import { MAX_GENERATED_JSON_CHARS } from "@/lib/learning-limits";
import { studyItemTarget } from "@/lib/ai-budgets";
import { hasPageMarkers, pageCount } from "@/lib/source-markers";
import { splitSections } from "@/lib/study-sections";
import { detectOutline } from "@/lib/transcript-outline";

export const PROMPT_LIMITS = {
  maxSources: 50,
  maxSourceFilenameChars: 180,
  maxSourceTextChars: 200_000,
  maxCombinedSourceChars: 600_000,
  maxPromptChars: 650_000,
  /** Conservative four-characters-per-token estimate when no tokenizer is available. */
  maxPromptTokens: 165_000,
} as const;

export type PromptSource = { filename: string; text: string };

export class PromptInputLimitError extends Error {
  readonly field: string;
  readonly limit: number;
  readonly actual: number;

  constructor(field: string, limit: number, actual: number, unit = "character") {
    super(`${field} exceeds the ${limit.toLocaleString()} ${unit} limit (received ${actual.toLocaleString()}).`);
    this.name = "PromptInputLimitError";
    this.field = field;
    this.limit = limit;
    this.actual = actual;
  }
}

/**
 * Validate source material before it is interpolated into a model prompt.
 * This throws instead of truncating so the caller can report an actionable
 * error and never silently drop study material.
 */
export function validatePromptSources(sources: PromptSource[]): PromptSource[] {
  if (sources.length > PROMPT_LIMITS.maxSources) {
    throw new PromptInputLimitError(
      "source count",
      PROMPT_LIMITS.maxSources,
      sources.length,
    );
  }

  let combinedChars = 0;
  const validated = sources.map((source, index) => {
    const filenameChars = source.filename.length;
    if (filenameChars > PROMPT_LIMITS.maxSourceFilenameChars) {
      throw new PromptInputLimitError(
        `source ${index + 1} filename`,
        PROMPT_LIMITS.maxSourceFilenameChars,
        filenameChars,
      );
    }

    const text = source.text.trim();
    if (text.length > PROMPT_LIMITS.maxSourceTextChars) {
      throw new PromptInputLimitError(
        `source ${index + 1} extracted text`,
        PROMPT_LIMITS.maxSourceTextChars,
        text.length,
      );
    }

    combinedChars += filenameChars + text.length;
    return { filename: source.filename, text };
  });

  if (combinedChars > PROMPT_LIMITS.maxCombinedSourceChars) {
    throw new PromptInputLimitError(
      "combined extracted text",
      PROMPT_LIMITS.maxCombinedSourceChars,
      combinedChars,
    );
  }

  return validated;
}

/** Validate a completed prompt or upstream document before a model call. */
export function assertPromptWithinLimit(
  prompt: string,
  label = "generation prompt",
): string {
  if (prompt.length > PROMPT_LIMITS.maxPromptChars) {
    throw new PromptInputLimitError(
      label,
      PROMPT_LIMITS.maxPromptChars,
      prompt.length,
    );
  }
  const estimatedTokens = Math.ceil(prompt.length / 4);
  if (estimatedTokens > PROMPT_LIMITS.maxPromptTokens) {
    throw new PromptInputLimitError(
      label,
      PROMPT_LIMITS.maxPromptTokens,
      estimatedTokens,
      "token",
    );
  }
  return prompt;
}

export const NO_INVENT_CITATIONS =
  "Do not invent page numbers, quotes, or facts the sources do not support. If something is unclear or missing, say so rather than guessing.";

export const NO_META_TEXT =
  "Write only study content. Do not describe the document itself, how it was written, or its citations, and do not add a references or bibliography list.";

export const CITE_EVERY_CLAIM =
  "End every factual sentence, bullet, and table row with its citation in the exact form [S1 p.14], [S1 pp.14-15], or [S2] for a source without pages. Cite only pages whose text supports the claim. Never cite a page you did not read. Include only what the sources state; leave out explanations, consequences or background the sources do not give.";

const NO_AUTOMATIC_HIGHLIGHTING =
  "Do not add HTML spans, semantic ink classes, or automatic highlighting. Keep the Markdown content plain so the learner can manage highlights and notes. Bracket citations such as [S1 p.14] are allowed and are not highlighting.";

export const FAITHFUL_RESTATEMENT =
  "Restate only what the cited page says. Do not add causes, consequences, comparisons, applications or 'why' explanations the page does not state, and keep the direction of every relation exactly as the page gives it (more or less, increases or decreases).";

export const PHARMACY_GUIDANCE =
  "Drug tables apply only if the sources actually describe specific drugs or drug classes. If they do, give each drug class a GFM table with the columns Drug(s) | Mechanism | Key uses | Adverse effects | Interactions or contraindications, fill every cell only from the sources, cite each row, and write \"Not in sources\" in any cell the sources do not cover. If the sources do not describe drugs, skip this entirely: write no drug table, no placeholder rows, and no note about topics the sources do not cover.";

export const COMPARISON_TABLES =
  "Comparison tables apply only if the sources themselves compare three or more items of one kind (organisms, tests, stains, specimens, diseases, drug classes) on two or more of the same attributes. If they do, add one GFM table for that comparison inside the section it belongs to, with the items as rows and only the attributes the sources give as columns; fill every cell only from the sources, cite each row, and write \"Not in sources\" in a cell the sources do not cover. Do not repeat a drug table already required above. Otherwise write no comparison table and no note about it.";

const SECTION_COVERAGE =
  "Cover every ## section in proportion to its length; every section with factual content gets at least one item. Do not cluster items in the opening sections.";

/** Summary length target: about 40% of Locked In, never below 1,500 characters. */
export function summaryTargetChars(lockedInMarkdown: string): number {
  return Math.max(1500, Math.round((lockedInMarkdown.length * 0.4) / 100) * 100);
}

const PAGE_MARKER_NOTE =
  "A line of the form <<<page N>>> marks the start of page or slide N of that source." +
  " Text after a <<<slide image>>> line was read from that page's picture (figures, graphs, equations, handwriting); cite it with that page like any other text.";

/** Source blocks labelled S1..Sn in the given order, with page ranges when known. */
function sourceBlocks(sources: PromptSource[]): { block: string; hasPages: boolean } {
  let anyPages = false;
  const block = sources
    .map((source, i) => {
      const pages = hasPageMarkers(source.text) ? pageCount(source.text) : 0;
      if (pages > 0) anyPages = true;
      const range = pages > 0 ? ` (pages 1-${pages})` : "";
      return `### Source S${i + 1}: ${source.filename}${range}\n\n${source.text}`;
    })
    .join("\n\n---\n\n");
  return { block, hasPages: anyPages };
}

/** One paragraph and list per source that opens with a lecturer outline; empty when none does. */
function outlineBlocks(sources: PromptSource[]): string {
  const blocks: string[] = [];
  sources.forEach((source, i) => {
    const outline = detectOutline(source.text);
    if (!outline) return;
    const items = outline.sections.flatMap((section) => [
      `- ${section.heading}`,
      ...section.subs.map((sub) => `  - ${sub}`),
    ]);
    blocks.push(
      `Source S${i + 1} has the lecturer's outline below. Use its top-level entries, in this order and wording (without numerals), as the ## headings for that source's material, and its sub-entries as ### headings. Put material that fits no entry under the nearest entry. This order overrides the chronological and topic rules above.\n\n${items.join("\n")}`,
    );
  });
  return blocks.length > 0 ? `# Lecturer outlines\n\n${blocks.join("\n\n")}\n\n` : "";
}

export function lockedInPrompt(
  extractedTexts: PromptSource[],
): string {
  const validatedSources = validatePromptSources(extractedTexts);
  const { block: sourcesBlock, hasPages } = sourceBlocks(validatedSources);
  const outlinesBlock = outlineBlocks(validatedSources);

  return assertPromptWithinLimit(`You are writing a comprehensive study document called "Locked In" from the extracted source materials below.

Requirements:
- Produce cohesive, long-form Markdown suitable for serious study.
- When the sources imply a chronological or sequential order (lectures, timelines, numbered modules, dated notes), organize the document chronologically.
- Otherwise organize by clear topic headings (## / ###).
- Merge overlapping content; resolve minor contradictions by preferring the most specific source and noting uncertainty briefly when needed.
- Be thorough: definitions, key claims, examples, formulas, procedures, and relationships between ideas.
- ${CITE_EVERY_CLAIM}
- ${FAITHFUL_RESTATEMENT}
- ${PHARMACY_GUIDANCE}
- ${COMPARISON_TABLES}
- ${NO_AUTOMATIC_HIGHLIGHTING}
- ${NO_INVENT_CITATIONS}
- ${NO_META_TEXT}
- Do not add quiz, self-check, checkpoint or review-question sections; Test Me covers practice.
- Do not describe this document or its purpose.
- Output Markdown only. No preamble or closing remarks outside the document.

${outlinesBlock}# Source materials
${hasPages ? `\n${PAGE_MARKER_NOTE}\n` : ""}
${sourcesBlock}`
  );
}

/**
 * Per-section Summary targets: about 40% of each Locked In "##" section, never
 * below 150 characters. Free models ignore a single total and spend most of it
 * on the opening sections; a line per section keeps the later ones covered.
 * Empty when Locked In has fewer than two sections.
 */
function summarySectionBudgets(lockedInMarkdown: string): string {
  const { sections } = splitSections(lockedInMarkdown);
  if (sections.length < 2) return "";
  const lines = sections.map((section) => {
    const chars = Math.max(150, Math.round((section.markdown.length * 0.4) / 10) * 10);
    return `- ${section.heading}: about ${chars.toLocaleString("en-US")} characters`;
  });
  return `\nSection budgets (about 40% of each Locked In section):\n${lines.join("\n")}`;
}

/** Single-request Summary prompt; the Summary step now uses summaryHalfPrompt. */
export function summaryPrompt(lockedInMarkdown: string): string {
  const target = summaryTargetChars(lockedInMarkdown).toLocaleString("en-US");
  const sectionBudgets = summarySectionBudgets(lockedInMarkdown);
  return assertPromptWithinLimit(`You are writing a detailed "Summary" study document for last-minute review.

Requirements:
- Derive the summary **only** from the Locked In document below, not from external knowledge or other sources.
- Keep it detailed enough to review the full material. Aim for about ${target} characters, about 40% of Locked In's length.${sectionBudgets}
- Use clear Markdown with headings that mirror Locked In structure when helpful.
- Do not number tables or figures from the slides (write 'Table: Sources of antimicrobials', not 'Table 2: Sources of antimicrobials'). Put no citations in headings; cite the bullets and table rows under them.
- Prefer bullets and tight paragraphs for scannability; preserve critical definitions, numbers, and distinctions.
- Keep Locked In's citations verbatim: end every factual sentence, bullet, and table row with the exact citation (for example [S1 p.14], [S1 pp.14-15], or [S2]) that the supporting Locked In claim carries. Never create a new citation. Leave out any Locked In claim that carries [[unsourced]] or has no citation.
- ${FAITHFUL_RESTATEMENT}
- ${PHARMACY_GUIDANCE}
- ${NO_AUTOMATIC_HIGHLIGHTING}
- ${NO_INVENT_CITATIONS}
- ${NO_META_TEXT}
- Output Markdown only. No preamble or closing remarks.

# Locked In document

${lockedInMarkdown}`
  );
}

export type SummaryHalfOptions = {
  part: 1 | 2;
  parts: 1 | 2;
  /** Code-set bullet ceilings for each "##" section of this part. */
  bulletLimits: Array<{ heading: string; bullets: number }>;
  targetChars: number;
  /** The retry after a cut-off or over-long answer: half the bullets. */
  strict?: boolean;
};

/**
 * Summary for one part of Locked In. Bullet ceilings per section replace a
 * character budget: free models ignored character targets and copied Locked In
 * until the output cap cut them off, but they keep to a bullet count.
 */
export function summaryHalfPrompt(half: string, options: SummaryHalfOptions): string {
  const target = Math.max(0, Math.round(options.targetChars)).toLocaleString("en-US");
  const limits = options.bulletLimits.length > 0
    ? `\n- Bullet limits per section:\n${options.bulletLimits
      .map((limit) => `  - ${limit.heading}: at most ${limit.bullets} bullets`)
      .join("\n")}`
    : "";
  const partNote = options.parts === 2
    ? `\n- This is part ${options.part} of 2 of the Summary; summarize only the Locked In part below.${
      options.part === 2 ? " Do not repeat the document title; start with this part's first section heading." : ""}`
    : "";
  const strict = options.strict
    ? "\n- Your previous answer was too long or cut off. Use at most half the bullets."
    : "";
  return assertPromptWithinLimit(`You are writing a concise "Summary" study document for last-minute review.

Requirements:
- Derive the summary **only** from the Locked In part below, not from external knowledge or other sources.${partNote}
- Keep every ## section of this part, in order, with its heading.${limits}
- Write each bullet in under 30 words. Aim for about ${target} characters in total.
- Never copy a Locked In sentence verbatim; compress each point to its key fact, number or distinction.
- Keep a table only when it compresses the material, with at most 6 rows.
- Do not number tables or figures from the slides (write 'Table: Sources of antimicrobials', not 'Table 2: Sources of antimicrobials'). Put no citations in headings; cite the bullets and table rows under them.
- Keep Locked In's citations verbatim: end every factual bullet and table row with the exact citation (for example [S1 p.14], [S1 pp.14-15], or [S2]) that the supporting Locked In claim carries. Never create a new citation. Leave out any Locked In claim that carries [[unsourced]] or has no citation.${strict}
- ${FAITHFUL_RESTATEMENT}
- ${PHARMACY_GUIDANCE}
- ${NO_AUTOMATIC_HIGHLIGHTING}
- ${NO_INVENT_CITATIONS}
- ${NO_META_TEXT}
- Output Markdown only. No preamble or closing remarks.

# Locked In ${options.parts === 2 ? `part ${options.part} of 2` : "document"}

${half}`
  );
}

export function testMePrompt(
  lockedInMarkdown: string,
  maxItems = studyItemTarget("test_me", lockedInMarkdown),
): string {
  return assertPromptWithinLimit(`You are creating a "Test Me" quiz from the Locked In study document below.

Requirements:
- Derive every question **only** from Locked In.
- Return a JSON array (no markdown fences, no commentary) of objects with this exact shape:
  {
    "id": string (stable short id, e.g. "q1"),
    "s1_question": string,
    "s2_choices": string[] (required; at least two answer choices, without "A." or "1." labels),
    "s3_explanation": string (why the correct choice is right, written before choosing),
    "s4_answer": string (the correct choice, copied exactly from s2_choices)
  }
- Write the fields in that order. Work out the explanation first, then copy the choice it supports into s4_answer.
- Every item must be multiple-choice with at least two non-empty choices. Use recall, comparison, and application questions when the material supports it.
- When the material is clinical (patients, drugs, diseases), write about a third of the items as short case vignettes (a brief patient scenario followed by the question). Never prefix a question with a label such as "Clinical Case:".
- State facts directly in questions and explanations. Never refer to the source material itself: no "The document states", "in the document", "The text states", "The lecture says", "According to Locked In", or similar.
- End every s3_explanation with the exact citation of the supporting Locked In claim, for example [S1 p.14], [S1 pp.14-15], or [S2]. Copy citations only from Locked In; never create new ones.
- Return about ${maxItems} items (never more than ${maxItems}); return fewer only when the material has fewer distinct facts.
- ${SECTION_COVERAGE}
- Use no more than 8 choices per item. Keep each question, answer, and explanation concise enough to fit the output budget.
- ${NO_INVENT_CITATIONS}
- Output raw JSON only: a single array starting with [ and ending with ].

# Locked In document

${lockedInMarkdown}`
  );
}

export function cardedPrompt(
  summaryMarkdown: string,
  maxItems = studyItemTarget("carded", summaryMarkdown),
): string {
  return assertPromptWithinLimit(`You are creating "Carded" flashcards from the Summary document below.

Requirements:
- Derive every card **only** from the Summary.
- Return a JSON array (no markdown fences, no commentary) of objects with this exact shape:
  {
    "id": string (stable short id, e.g. "c1"),
    "front": string (prompt / term / question),
    "back": string (answer / definition / explanation)
  }
- One atomic idea per card. Front should be answerable without seeing the back.
- State facts directly. Never refer to the source material itself: no "in the document", "according to the Summary", "the text says", or similar.
- For a fill-in-the-blank card, the front may use one or more balanced {{answer}} placeholders. Keep each placeholder short and put the explanation in back.
- Prefer cloze {{...}} cards for short lists worth memorizing, such as an adverse-effect triad or the drugs in a class.
- End every back with the exact citation of the supporting Summary claim, for example [S1 p.14], [S1 pp.14-15], or [S2]. Copy citations only from the Summary; never create new ones.
- Return about ${maxItems} cards (never more than ${maxItems}); return fewer only when the material has fewer distinct facts.
- ${SECTION_COVERAGE}
- Skip quotations, epigraphs, mottos and motivational lines. Every card tests a definition, mechanism, drug, dose, number, classification or distinction.
- Keep each front and back below 20,000 characters.
- ${NO_INVENT_CITATIONS}
- Output raw JSON only: a single array starting with [ and ending with ].

# Summary document

${summaryMarkdown}`
  );
}

/** One batched support check; each sentence is judged only against its own evidence. */
export function groundingVerifyPrompt(
  items: ReadonlyArray<{ id: number; sentence: string; evidence: string }>,
): string {
  const payload = JSON.stringify(
    items.map((item) => ({ id: item.id, sentence: item.sentence, evidence: item.evidence })),
  );
  return assertPromptWithinLimit(`You are checking whether sentences from a study document are supported by source text.

Rules:
- Judge each sentence ONLY against the evidence text given in the same item. Ignore outside knowledge and ignore other items, even when you know the sentence is true.
- List in "missing" every fact, name, number, mechanism, cause, or example in the sentence that the evidence does not state. Paraphrase of what the evidence says is fine and is not missing.
- Paraphrase, synonyms, abbreviations, summarising several evidence lines, and reordering are not missing.
- Do not list connective words, framing, or general phrasing. List only specific facts (names, numbers, drugs, doses, mechanisms, causes, examples) that the evidence never states.
- A sentence whose facts are all stated in its evidence has an empty "missing" list.
- Ignore bracket citations such as [S1 p.14] inside the sentence.
- Return one entry per item, keeping each id.
- Output raw JSON only: a single array such as [{"id": 0, "missing": []}, {"id": 1, "missing": ["acute tubular necrosis"]}], with "id" a number and "missing" an array of short strings. No markdown fences, no commentary.

# Items

${payload}`,
    "grounding verify prompt",
  );
}

export function repairJsonPrompt(
  kind: "test_me" | "carded",
  raw: string,
): string {
  if (raw.length > MAX_GENERATED_JSON_CHARS) {
    throw new PromptInputLimitError(
      "JSON repair input",
      MAX_GENERATED_JSON_CHARS,
      raw.length,
    );
  }
  const shape =
    kind === "test_me"
      ? `[{ "id": string, "question": string, "choices": string[], "answer": string, "explanation": string }]`
      : `[{ "id": string, "front": string, "back": string }]`;

  return assertPromptWithinLimit(`The following model output was supposed to be a JSON array of ${kind === "test_me" ? "quiz" : "flashcard"} items but failed to parse as JSON.

Repair it into valid JSON only:
- A single JSON array matching: ${shape}
- No markdown fences, no commentary, no trailing text.
- Keep the educational content; fix structure, quotes, commas, and truncated tails as needed.
- If the input is unusable, return the best possible minimal valid array (at least one item if any content is recoverable, else []).

# Broken output

${raw}`,
    "JSON repair prompt",
  );
}
