/** Plain prompt strings for the study-pack generation pipeline. No secrets. */

import { MAX_GENERATED_JSON_CHARS } from "@/lib/learning-limits";
import { classifySourceLength, estimateTokensFromText } from "@/lib/ai-budgets";
import { hasPageMarkers, pageCount } from "@/lib/source-markers";

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
  "End every factual sentence, bullet, and table row with its citation in the exact form [S1 p.14], [S1 pp.14-15], or [S2] for a source without pages. Cite only pages whose text supports the claim. Never cite a page you did not read. If a helpful clarification is not in the sources you may include it, but give it no citation.";

const NO_AUTOMATIC_HIGHLIGHTING =
  "Do not add HTML spans, semantic ink classes, or automatic highlighting. Keep the Markdown content plain so the learner can manage highlights and notes. Bracket citations such as [S1 p.14] are allowed and are not highlighting.";

export const PHARMACY_GUIDANCE =
  "When the sources cover drugs or pharmacology, give each drug class a GFM table with the columns Drug(s) | Mechanism | Key uses | Adverse effects | Interactions or contraindications. Fill every cell only from the sources, cite each row, and write \"Not in sources\" in any cell the sources do not cover.";

const PAGE_MARKER_NOTE =
  "A line of the form <<<page N>>> marks the start of page or slide N of that source.";

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

export function lockedInPrompt(
  extractedTexts: PromptSource[],
): string {
  const validatedSources = validatePromptSources(extractedTexts);
  const { block: sourcesBlock, hasPages } = sourceBlocks(validatedSources);

  return assertPromptWithinLimit(`You are writing a comprehensive study document called "Locked In" from the extracted source materials below.

Requirements:
- Produce cohesive, long-form Markdown suitable for serious study.
- When the sources imply a chronological or sequential order (lectures, timelines, numbered modules, dated notes), organize the document chronologically.
- Otherwise organize by clear topic headings (## / ###).
- Merge overlapping content; resolve minor contradictions by preferring the most specific source and noting uncertainty briefly when needed.
- Be thorough: definitions, key claims, examples, formulas, procedures, and relationships between ideas.
- ${CITE_EVERY_CLAIM}
- ${PHARMACY_GUIDANCE}
- ${NO_AUTOMATIC_HIGHLIGHTING}
- ${NO_INVENT_CITATIONS}
- ${NO_META_TEXT}
- Output Markdown only. No preamble or closing remarks outside the document.

# Source materials
${hasPages ? `\n${PAGE_MARKER_NOTE}\n` : ""}
${sourcesBlock}`
  );
}

export function summaryPrompt(lockedInMarkdown: string): string {
  return assertPromptWithinLimit(`You are writing a detailed "Summary" study document for last-minute review.

Requirements:
- Derive the summary **only** from the Locked In document below, not from external knowledge or other sources.
- Keep it detailed enough to review the full material, but denser and shorter than Locked In.
- Use clear Markdown with headings that mirror Locked In structure when helpful.
- Prefer bullets and tight paragraphs for scannability; preserve critical definitions, numbers, and distinctions.
- Keep Locked In's citations verbatim: end every factual sentence, bullet, and table row with the exact citation (for example [S1 p.14], [S1 pp.14-15], or [S2]) that the supporting Locked In claim carries. Never create a new citation. Do not copy [[unsourced]] markers; leave those claims uncited.
- ${PHARMACY_GUIDANCE}
- ${NO_AUTOMATIC_HIGHLIGHTING}
- ${NO_INVENT_CITATIONS}
- ${NO_META_TEXT}
- Output Markdown only. No preamble or closing remarks.

# Locked In document

${lockedInMarkdown}`
  );
}

export function testMePrompt(
  lockedInMarkdown: string,
  maxItems = ({ short: 5, medium: 10, long: 20 } as const)[
    classifySourceLength(estimateTokensFromText(lockedInMarkdown))
  ],
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
- State facts directly in questions and explanations. Never refer to the source material itself: no "The document states", "The text states", "The lecture says", "According to Locked In", or similar.
- End every s3_explanation with the exact citation of the supporting Locked In claim, for example [S1 p.14], [S1 pp.14-15], or [S2]. Copy citations only from Locked In; never create new ones.
- Return no more than ${maxItems} items and no more than 8 choices per item. Keep each question, answer, and explanation concise enough to fit the output budget.
- Aim for enough items to meaningfully assess the material while staying within that limit; return fewer when the source has fewer distinct facts.
- ${NO_INVENT_CITATIONS}
- Output raw JSON only: a single array starting with [ and ending with ].

# Locked In document

${lockedInMarkdown}`
  );
}

export function cardedPrompt(
  summaryMarkdown: string,
  maxItems = ({ short: 10, medium: 20, long: 30 } as const)[
    classifySourceLength(estimateTokensFromText(summaryMarkdown))
  ],
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
- For a fill-in-the-blank card, the front may use one or more balanced {{answer}} placeholders. Keep each placeholder short and put the explanation in back.
- Prefer cloze {{...}} cards for short lists worth memorizing, such as an adverse-effect triad or the drugs in a class.
- End every back with the exact citation of the supporting Summary claim, for example [S1 p.14], [S1 pp.14-15], or [S2]. Copy citations only from the Summary; never create new ones.
- Return no more than ${maxItems} cards. Keep each front and back below 20,000 characters.
- Aim for enough cards to cover the Summary while staying within that limit; return fewer when the Summary has fewer distinct facts.
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
