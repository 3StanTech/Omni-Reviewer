/** Plain prompt strings for the study-pack generation pipeline. No secrets. */

import { MAX_GENERATED_JSON_CHARS } from "@/lib/learning-limits";
import { classifySourceLength, estimateTokensFromText } from "@/lib/ai-budgets";

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
  "Do not invent citations, quotes, page numbers, or facts the sources do not support. If something is unclear or missing, say so rather than guessing.";

const NO_AUTOMATIC_HIGHLIGHTING =
  "Do not add HTML spans, semantic ink classes, or automatic highlighting. Keep the Markdown content plain so the learner can manage highlights and notes.";

export function lockedInPrompt(
  extractedTexts: PromptSource[],
): string {
  const validatedSources = validatePromptSources(extractedTexts);
  const sourcesBlock = validatedSources
    .map(
      (s, i) =>
        `### Source ${i + 1}: ${s.filename}\n\n${s.text}`,
    )
    .join("\n\n---\n\n");

  return assertPromptWithinLimit(`You are writing a comprehensive study document called "Locked In" from the extracted source materials below.

Requirements:
- Produce cohesive, long-form Markdown suitable for serious study.
- When the sources imply a chronological or sequential order (lectures, timelines, numbered modules, dated notes), organize the document chronologically.
- Otherwise organize by clear topic headings (## / ###).
- Merge overlapping content; resolve minor contradictions by preferring the most specific source and noting uncertainty briefly when needed.
- Be thorough: definitions, key claims, examples, formulas, procedures, and relationships between ideas.
- ${NO_AUTOMATIC_HIGHLIGHTING}
- ${NO_INVENT_CITATIONS}
- Output Markdown only. No preamble or closing remarks outside the document.

# Source materials

${sourcesBlock}`
  );
}

export function summaryPrompt(lockedInMarkdown: string): string {
  return assertPromptWithinLimit(`You are writing a detailed "Summary" study document for last-minute review.

Requirements:
- Derive the summary **only** from the Locked In document below — not from external knowledge or other sources.
- Keep it detailed enough to review the full material, but denser and shorter than Locked In.
- Use clear Markdown with headings that mirror Locked In structure when helpful.
- Prefer bullets and tight paragraphs for scannability; preserve critical definitions, numbers, and distinctions.
- ${NO_AUTOMATIC_HIGHLIGHTING}
- ${NO_INVENT_CITATIONS}
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
    "question": string,
    "choices": string[] (required; include at least two answer choices),
    "answer": string,
    "explanation": string
  }
- Every item must be multiple-choice with at least two non-empty choices. Use recall, comparison, and application questions when the material supports it.
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
- Return no more than ${maxItems} cards. Keep each front and back below 20,000 characters.
- Aim for enough cards to cover the Summary while staying within that limit; return fewer when the Summary has fewer distinct facts.
- ${NO_INVENT_CITATIONS}
- Output raw JSON only: a single array starting with [ and ending with ].

# Summary document

${summaryMarkdown}`
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
