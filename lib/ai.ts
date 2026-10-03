import "server-only";

import { generateObject, generateText, NoObjectGeneratedError, type FinishReason } from "ai";
import { z } from "zod";

import {
  ASK_OUTPUT_TOKENS,
  assertGenerationBudget,
  estimateTokensFromText,
  generationBudget,
  studyItemTarget,
} from "@/lib/ai-budgets";
import {
  buildAskPrompt,
  groundAnswer,
  parseAskAnswer,
  selectAskSources,
  type AskHistoryMessage,
  type AskPagesSent,
  type AskSourceInput,
} from "@/lib/ask";
import {
  citationPattern,
  dropUnknownSourceCitations,
  type CitationSourceRef,
  type StudyDocumentMeta,
} from "@/lib/citations";
import {
  GenerationError,
  publicGenerationErrorMessage,
  toGenerationError,
} from "@/lib/generation-errors";
import {
  groundDocument,
  type GroundingReport,
  type GroundingSource,
  type VerifyItem,
} from "@/lib/grounding";
import { getEnv } from "@/lib/env";
import { contextWindowForRequest, getOpenRouterModel } from "@/lib/openrouter";
import { isValidCardFront, normalizeLearningIds } from "@/lib/learning";
import {
  MAX_CARD_BACK_CHARS,
  MAX_CARD_FRONT_CHARS,
  MAX_CARDED_ITEMS,
  MAX_GENERATED_JSON_CHARS,
  MAX_GENERATED_MARKDOWN_CHARS,
  GENERATION_CONTEXT_SAFETY_MARGIN_TOKENS,
  GENERATION_STEP_DEADLINE_MS,
  MAX_GENERATION_ATTEMPTS,
  MAX_LEARNING_ID_CHARS,
  MAX_TEST_ME_ANSWER_CHARS,
  MAX_TEST_ME_CHOICE_CHARS,
  MAX_TEST_ME_CHOICES,
  MAX_TEST_ME_EXPLANATION_CHARS,
  MAX_TEST_ME_ITEMS,
  MAX_TEST_ME_QUESTION_CHARS,
  MAX_VISION_OUTPUT_TOKENS,
  MAX_VISION_TEXT_CHARS,
  GROUNDED_STEP_TOTAL_MS,
  GROUNDING_VERIFY_DEADLINE_MS,
  MAX_GROUNDING_EVIDENCE_CHARS,
  MAX_GROUNDING_VERIFY_ITEMS,
  MIN_GROUNDING_VERIFY_MS,
} from "@/lib/learning-limits";
import {
  PROMPT_LIMITS,
  PromptInputLimitError,
  assertPromptWithinLimit,
  cardedPrompt,
  groundingVerifyPrompt,
  lockedInPrompt,
  summaryHalfPrompt,
  testMePrompt,
} from "@/lib/prompts";
import { hasPageMarkers } from "@/lib/source-markers";
import { itemPages, sectionPages, uncoveredSections } from "@/lib/study-coverage";
import { stripDocumentFraming } from "@/lib/study-framing";
import { sanitizeStudyHeadings } from "@/lib/study-headings";
import { allocateItems, balancedHalves, splitSections } from "@/lib/study-sections";
import { capSummarySections } from "@/lib/summary-cap";
import type { CardedItem, TestMeItem } from "@/lib/types";

export type GenerationPurpose = "locked_in" | "summary" | "json" | "vision" | "ask";

export type StudyPackStep = "locked_in" | "summary" | "test_me" | "carded";

/** Thrown when structured JSON from the model cannot be parsed after fallbacks. */
export class StudyPackJsonError extends Error {
  readonly kind: "test_me" | "carded";
  readonly raw: string;

  constructor(kind: "test_me" | "carded", message: string, raw: string) {
    super(message);
    this.name = "StudyPackJsonError";
    this.kind = kind;
    this.raw = raw;
  }
}

const testMeItemSchema = z
  .object({
    id: z.string().trim().min(1).max(MAX_LEARNING_ID_CHARS),
    question: z.string().trim().min(1).max(MAX_TEST_ME_QUESTION_CHARS),
    choices: z.array(z.string().trim().min(1).max(MAX_TEST_ME_CHOICE_CHARS))
      .min(2)
      .max(MAX_TEST_ME_CHOICES),
    answer: z.string().trim().min(1).max(MAX_TEST_ME_ANSWER_CHARS),
    explanation: z.string().max(MAX_TEST_ME_EXPLANATION_CHARS),
  })
  .superRefine((item, context) => {
    if (!item.choices.includes(item.answer)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: "answer must exactly match one of choices",
      });
    } else if (explanationContradictsAnswer(item)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: "explanation supports a different choice than answer",
      });
    }
  })
  .strict();

/**
 * Wire shape for Test Me. Free models were seen emitting keys in alphabetical
 * order, which put "answer" before the question was written and produced wrong
 * answer keys. The numbered names make every ordering reason before answering.
 */
const testMeWireItemSchema = z
  .object({
    id: z.string(),
    s1_question: z.string(),
    s2_choices: z.array(z.string()),
    s3_explanation: z.string(),
    s4_answer: z.string(),
  })
  .strict()
  .transform((wire) => repairQuizAnswer({
    id: wire.id,
    question: wire.s1_question,
    choices: wire.s2_choices,
    answer: wire.s4_answer,
    explanation: wire.s3_explanation,
  }))
  .pipe(testMeItemSchema);

const cardedItemSchema = z.object({
  id: z.string().trim().min(1).max(MAX_LEARNING_ID_CHARS),
  front: z.string().trim().min(1).max(MAX_CARD_FRONT_CHARS),
  back: z.string().trim().min(1).max(MAX_CARD_BACK_CHARS),
}).strict().superRefine((item, context) => {
  if (!isValidCardFront(item.front)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["front"],
      message: "cloze cards must use balanced {{answer}} placeholders",
    });
  }
});

function modelIdForPurpose(purpose: GenerationPurpose): string {
  const env = getEnv();
  switch (purpose) {
    case "locked_in":
      return env.AI_MODEL_LOCKED_IN;
    case "summary":
    case "ask":
      return env.AI_MODEL_SUMMARY;
    case "json":
      return env.AI_MODEL_JSON;
    case "vision":
      return env.AI_MODEL_VISION;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jitterDelay(attempt: number): number {
  const base = 400 * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    attempts: number;
    deadlineMs: number;
  },
): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error("aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new GenerationError("timeout", "Generation timed out.", true)),
    options.deadlineMs,
  );
  let lastError: unknown;
  try {
    for (let attempt = 1; attempt <= options.attempts; attempt++) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("aborted");
      }
      try {
        return await fn(controller.signal);
      } catch (err) {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : err;
        }
        lastError = err;
        const classified = toGenerationError(err);
        if (!classified.retryable || attempt === options.attempts) {
          throw classified;
        }
        await sleep(jitterDelay(attempt), controller.signal);
      }
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
  throw toGenerationError(lastError);
}

function extractModelUsed(
  result: { response?: { modelId?: string }; providerMetadata?: unknown },
  requested: string,
): string {
  const fromResponse = result.response?.modelId;
  if (typeof fromResponse === "string" && fromResponse.trim()) {
    return fromResponse;
  }
  const meta = result.providerMetadata as
    | { openrouter?: { model?: string } }
    | undefined;
  const fromMeta = meta?.openrouter?.model;
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta;
  }
  return requested;
}

export function getModelId(purpose: GenerationPurpose = "locked_in"): string {
  return modelIdForPurpose(purpose);
}

export async function generateTextFromPrompt(
  prompt: string,
  options: {
    purpose: GenerationPurpose;
    signal?: AbortSignal;
    sourceTokens?: number;
    /** Overall deadline across attempts; defaults to the generation step deadline. */
    deadlineMs?: number;
  } = { purpose: "locked_in" },
): Promise<{ text: string; modelUsed: string; finishReason: FinishReason }> {
  assertPromptWithinLimit(prompt);
  const modelId = modelIdForPurpose(options.purpose);
  const healJson = options.purpose === "json";
  const budget = generationBudget(
    options.purpose,
    options.sourceTokens ?? estimateTokensFromText(prompt),
    {
      contextWindowTokens: contextWindowForRequest(modelId),
      attempts: MAX_GENERATION_ATTEMPTS,
      deadlineMs: options.deadlineMs ?? GENERATION_STEP_DEADLINE_MS,
      safetyMarginTokens: GENERATION_CONTEXT_SAFETY_MARGIN_TOKENS,
    },
  );
  assertGenerationBudget(prompt, budget);

  return withRetry(async (signal) => {
    const { text, response, providerMetadata, finishReason } = await generateText({
      model: getOpenRouterModel(modelId, { healJson }),
      prompt,
      maxRetries: 0,
      maxOutputTokens: budget.maxOutputTokens,
      abortSignal: signal,
    });
    const normalizedText = text.trim();
    if (!normalizedText) {
      // Reasoning models can spend the whole output budget thinking and return
      // no answer. That is a failed attempt, never empty study content.
      throw new GenerationError(
        "unavailable",
        "The model returned no text. Try again.",
        true,
      );
    }
    if (normalizedText.length > MAX_GENERATED_MARKDOWN_CHARS) {
      throw new GenerationError(
        "token_limit",
        "Generated text exceeds the safe output limit.",
        false,
      );
    }
    return {
      text: normalizedText,
      modelUsed: extractModelUsed({ response, providerMetadata }, modelId),
      // "length" means the output cap cut the text off.
      finishReason,
    };
  }, {
    signal: options.signal,
    attempts: budget.attempts,
    deadlineMs: budget.deadlineMs,
  });
}

type VisionContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: Uint8Array; mediaType: string };

/**
 * The one vision request both readers share, so the model, output cap, and
 * retry policy cannot drift between single images and slide batches.
 */
async function runVision(
  content: VisionContentPart[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const modelId = modelIdForPurpose("vision");

  return withRetry(async (attemptSignal) => {
    const { text } = await generateText({
      model: getOpenRouterModel(modelId),
      maxRetries: 0,
      abortSignal: attemptSignal,
      maxOutputTokens: MAX_VISION_OUTPUT_TOKENS,
      messages: [{ role: "user", content }],
    });
    const normalizedText = text.trim();
    if (normalizedText.length > MAX_VISION_TEXT_CHARS) {
      throw new GenerationError(
        "token_limit",
        "Vision output exceeds the safe text limit.",
        false,
      );
    }
    return normalizedText;
  }, {
    signal,
    attempts: MAX_GENERATION_ATTEMPTS,
    deadlineMs: GENERATION_STEP_DEADLINE_MS,
  });
}

export async function visionReadImages(
  images: { mime: string; bytes: Uint8Array }[],
  instruction: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (images.length === 0) {
    throw new Error("visionReadImages requires at least one image");
  }
  return runVision(
    [
      { type: "text", text: instruction },
      ...images.map((img) => ({
        type: "image" as const,
        image: img.bytes,
        mediaType: img.mime,
      })),
    ],
    options.signal,
  );
}

/**
 * Read a batch of slide pictures in one request. Each image is preceded by a
 * "Slide N:" label so the model can mark its reading with that page number.
 */
export async function visionReadPages(
  pages: { page: number; mime: "image/jpeg"; bytes: Uint8Array }[],
  instruction: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (pages.length === 0) {
    throw new Error("visionReadPages requires at least one page");
  }
  return runVision(
    [
      { type: "text", text: instruction },
      ...pages.flatMap((entry) => [
        { type: "text" as const, text: `Slide ${entry.page}:` },
        { type: "image" as const, image: entry.bytes, mediaType: entry.mime },
      ]),
    ],
    options.signal,
  );
}

function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function parseJsonArray(raw: string): unknown[] {
  if (raw.length > MAX_GENERATED_JSON_CHARS) {
    throw new RangeError("Generated JSON exceeds the safe output limit");
  }
  const cleaned = stripJsonFences(raw);
  const parsed: unknown = JSON.parse(cleaned);
  if (Array.isArray(parsed)) return parsed;
  // The AI SDK's array output mode wraps items as {"elements": [...]}.
  if (parsed && typeof parsed === "object") {
    const values = Object.values(parsed as Record<string, unknown>);
    if (values.length === 1 && Array.isArray(values[0])) return values[0];
  }
  throw new SyntaxError("Expected a JSON array");
}

function normalizeChoiceText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const CHOICE_LABEL = /^\(?([A-H])[.):]\s+/;
const BARE_LETTER_ANSWER = /^\(?([A-H])[.):]?$/;

/**
 * The UI numbers choices itself, so "A. Penicillin", "B. ..." labels are
 * dropped when every choice carries them in order. Three or more choices are
 * required so abbreviated names such as "A. baumannii" are left alone.
 */
function stripChoiceLabels(choices: string[]): string[] | null {
  if (choices.length < 3) return null;
  const labelled = choices.every((choice, index) =>
    CHOICE_LABEL.exec(choice)?.[1] === String.fromCharCode(65 + index));
  return labelled ? choices.map((choice) => choice.replace(CHOICE_LABEL, "")) : null;
}

/**
 * A quiz answer must equal one of its choices. Models sometimes answer with a
 * letter ("B"), a labelled choice ("B. Penicillin"), or a sentence that
 * contains exactly one choice; map those to the choice. Anything ambiguous is
 * left alone so validation drops the item.
 */
export function repairQuizAnswer(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const record = item as { choices?: unknown; answer?: unknown };
  if (!Array.isArray(record.choices) || typeof record.answer !== "string") return item;
  const rawChoices = record.choices.filter((choice): choice is string => typeof choice === "string");
  if (rawChoices.length !== record.choices.length) return item;
  const unlabelled = stripChoiceLabels(rawChoices);
  if (!unlabelled && rawChoices.includes(record.answer)) return item;
  const choices = unlabelled ?? rawChoices;
  const letter = BARE_LETTER_ANSWER.exec(record.answer.trim())?.[1];
  if (letter) {
    const chosen = choices[letter.charCodeAt(0) - 65];
    return chosen ? { ...record, choices, answer: chosen } : item;
  }
  const rawAnswer = unlabelled ? record.answer.replace(CHOICE_LABEL, "") : record.answer;
  if (choices.includes(rawAnswer)) return { ...record, choices, answer: rawAnswer };
  const answer = normalizeChoiceText(rawAnswer);
  const exact = choices.filter((choice) => normalizeChoiceText(choice) === answer);
  const contained = choices.filter((choice) => {
    const normalized = normalizeChoiceText(choice);
    return normalized.length > 0 && (answer.includes(normalized) || normalized.includes(answer));
  });
  const match = exact.length === 1 ? exact[0] : contained.length === 1 ? contained[0] : null;
  return match ? { ...record, choices, answer: match } : item;
}

const CHOICE_STOPWORDS = new Set(["the", "and", "of", "to", "in", "on", "for", "with", "by", "is", "are", "an", "or", "as", "at", "its", "it", "be"]);

function choiceTokens(text: string): Set<string> {
  return new Set(normalizeChoiceText(text).split(" ")
    .filter((token) => (token.length > 1 || /\d/.test(token)) && !CHOICE_STOPWORDS.has(token)));
}

/**
 * True when the explanation names none of the words that set the answer apart
 * from the other choices, yet names at least half of another choice's. Models
 * that pick the answer before reasoning write a correct explanation for a
 * wrong key; such items are dropped rather than taught.
 */
export function explanationContradictsAnswer(item: { choices: string[]; answer: string; explanation: string }): boolean {
  const explanation = choiceTokens(item.explanation);
  const tokens = item.choices.map(choiceTokens);
  const distinct = tokens.map((own, index) => [...own].filter((token) =>
    tokens.every((other, otherIndex) => otherIndex === index || !other.has(token))));
  const hitRate = (words: string[]) => words.filter((word) => explanation.has(word)).length / words.length;
  const answerIndex = item.choices.indexOf(item.answer);
  const answerWords = distinct[answerIndex];
  if (!answerWords || answerWords.length === 0 || hitRate(answerWords) > 0) return false;
  return distinct.some((words, index) => index !== answerIndex && words.length > 0 && hitRate(words) >= 0.5);
}

function tryParseJsonArrayLocally<T extends { id: string }>(
  elementSchema: z.ZodType<T>,
  raw: string,
  maxItems: number,
): T[] | null {
  if (!raw.trim()) return null;
  try {
    // Keep every item that validates after answer repair; one bad item should
    // not discard an otherwise usable quiz or deck.
    const valid = parseJsonArray(raw)
      .map((item) => elementSchema.safeParse(repairQuizAnswer(item)))
      .flatMap((result) => (result.success ? [result.data] : []));
    return valid.length > 0 ? valid.slice(0, maxItems) : null;
  } catch {
    return null;
  }
}

export function normalizeGeneratedIds<T extends { id: string }>(items: T[]): T[] {
  return normalizeLearningIds(items);
}

function normalizeGeneratedItems<T extends { id: string }>(
  kind: "test_me" | "carded",
  items: T[],
  maxItemsOverride?: number,
): { items: T[]; raw: string } {
  const maxItems = maxItemsOverride ?? (kind === "test_me" ? MAX_TEST_ME_ITEMS : MAX_CARDED_ITEMS);
  if (items.length === 0) {
    throw new GenerationError(
      "json_parse",
      `Generated ${kind} output must contain at least one item.`,
      false,
    );
  }
  if (items.length > maxItems) {
    throw new GenerationError(
      "json_parse",
      `Generated ${kind} output exceeds the safe item limit.`,
      false,
    );
  }
  const normalized = normalizeGeneratedIds(items);
  if (normalized.some((item) => item.id.length > MAX_LEARNING_ID_CHARS)) {
    throw new GenerationError(
      "json_parse",
      `Generated ${kind} output contains an item id that exceeds the safe size limit.`,
      false,
    );
  }
  const raw = JSON.stringify(normalized);
  if (raw.length > MAX_GENERATED_JSON_CHARS) {
    throw new GenerationError(
      "token_limit",
      "Generated structured output exceeds the safe size limit.",
      false,
    );
  }
  return { items: normalized, raw };
}

async function generateJsonArray<T extends { id: string }>(args: {
  kind: "test_me" | "carded";
  prompt: string;
  elementSchema: z.ZodType<T>;
  /** Page-scaled item target from studyItemTarget; also scales the output budget. */
  maxItems?: number;
  /** Overall deadline across attempts; defaults to the generation step deadline. */
  deadlineMs?: number;
}): Promise<{ items: T[]; modelUsed: string; raw: string }> {
  assertPromptWithinLimit(args.prompt);
  const modelId = modelIdForPurpose("json");
  const hardMaxItems = args.kind === "test_me" ? MAX_TEST_ME_ITEMS : MAX_CARDED_ITEMS;
  const budget = generationBudget(
    args.kind,
    estimateTokensFromText(args.prompt),
    {
      contextWindowTokens: contextWindowForRequest(modelId),
      attempts: MAX_GENERATION_ATTEMPTS,
      deadlineMs: args.deadlineMs ?? GENERATION_STEP_DEADLINE_MS,
      safetyMarginTokens: GENERATION_CONTEXT_SAFETY_MARGIN_TOKENS,
      ...(args.maxItems === undefined ? {} : { maxItems: args.maxItems }),
    },
  );
  assertGenerationBudget(args.prompt, budget);
  const maxItems = Math.min(budget.maxItems ?? hardMaxItems, hardMaxItems);
  let lastRaw = "";

  try {
    return await withRetry(async (signal) => {
      try {
        const result = await generateObject({
          model: getOpenRouterModel(modelId, { healJson: true }),
          output: "array",
          schema: args.elementSchema,
          prompt: args.prompt,
          maxRetries: 0,
          maxOutputTokens: budget.maxOutputTokens,
          abortSignal: signal,
        });
        // A model that overshoots the requested count still produced usable
        // items; keep the first maxItems rather than failing the whole step.
        const normalized = normalizeGeneratedItems(
          args.kind,
          (result.object as T[]).slice(0, maxItems),
          maxItems,
        );
        return {
          ...normalized,
          modelUsed: extractModelUsed(result, modelId),
        };
      } catch (err) {
        // Last resort local parse (no extra model call) when healing still fails.
        if (NoObjectGeneratedError.isInstance(err) && err.text) {
          lastRaw = err.text.length > MAX_GENERATED_JSON_CHARS
            ? err.text.slice(0, MAX_GENERATED_JSON_CHARS + 1)
            : err.text;
          const parsed = tryParseJsonArrayLocally(args.elementSchema, err.text, maxItems);
          if (parsed) {
            const normalized = normalizeGeneratedItems(args.kind, parsed, maxItems);
            return {
              ...normalized,
              modelUsed: extractModelUsed(
                { response: err.response },
                modelId,
              ),
            };
          }
        }
        throw err;
      }
    }, {
      attempts: budget.attempts,
      deadlineMs: budget.deadlineMs,
    });
  } catch (objectError) {
    const parsed = tryParseJsonArrayLocally(args.elementSchema, lastRaw, maxItems);
    if (parsed) {
      const normalized = normalizeGeneratedItems(args.kind, parsed, maxItems);
      return { ...normalized, modelUsed: modelId };
    }
    const detail =
      objectError instanceof Error ? objectError.message : "unknown parse error";
    throw new StudyPackJsonError(
      args.kind,
      `Failed to parse ${args.kind} JSON: ${detail}`,
      lastRaw,
    );
  }
}

/**
 * The verifier lists facts the evidence lacks; a sentence is supported only
 * when that list is empty. Naming the gap is stricter than a yes/no verdict,
 * which lenient free models tend to answer "yes". A bare boolean is still
 * accepted from models that ignore the requested shape.
 */
const verifyResultSchema = z
  .array(
    z.union([
      z.object({ id: z.number().int().nonnegative(), missing: z.array(z.string()).max(40) }),
      z.object({ id: z.number().int().nonnegative(), supported: z.boolean() }),
    ]),
  )
  .max(MAX_GROUNDING_VERIFY_ITEMS * 2)
  .transform((rows) =>
    rows.map((row) => ({
      id: row.id,
      supported: "missing" in row
        ? row.missing.every((fact) => !fact.trim())
        : row.supported,
    })),
  );

/**
 * One bounded verification call for the sentences grounding could not match
 * lexically. Single attempt, so a document step never spends more than one
 * extra provider call on grounding.
 */
async function verifyGroundingItems(
  items: VerifyItem[],
  deadlineMs: number,
): Promise<Array<{ id: number; supported: boolean }>> {
  const prompt = groundingVerifyPrompt(items);
  const modelId = modelIdForPurpose("json");
  const budget = generationBudget("verify", estimateTokensFromText(prompt), {
    contextWindowTokens: contextWindowForRequest(modelId),
    attempts: 1,
    deadlineMs,
    safetyMarginTokens: GENERATION_CONTEXT_SAFETY_MARGIN_TOKENS,
  });
  assertGenerationBudget(prompt, budget);
  return withRetry(async (signal) => {
    const { text } = await generateText({
      model: getOpenRouterModel(modelId, { healJson: true }),
      prompt,
      maxRetries: 0,
      maxOutputTokens: budget.maxOutputTokens,
      abortSignal: signal,
    });
    return verifyResultSchema.parse(parseJsonArray(text));
  }, { attempts: budget.attempts, deadlineMs: budget.deadlineMs });
}

/**
 * The production verifier call with its standard deadline, for the replay
 * probe script. Generation and Check again never call this.
 */
export function replayVerify(items: VerifyItem[]): Promise<Array<{ id: number; supported: boolean }>> {
  return verifyGroundingItems(items, GROUNDING_VERIFY_DEADLINE_MS);
}

/** S1..Sn identities for sources given in citation order. */
export function citationSourcesFor(
  sources: ReadonlyArray<{ filename: string; text: string; sourceId?: string }>,
): CitationSourceRef[] {
  return sources.map((source, i) => ({
    index: i + 1,
    sourceId: source.sourceId ?? "",
    filename: source.filename,
    hasPages: hasPageMarkers(source.text),
  }));
}

/**
 * Ground a generated document against its sources. Never throws for a
 * verifier problem: the report records `verifierFailed` and the step succeeds.
 */
async function groundGeneratedDocument(args: {
  markdown: string;
  sources: GroundingSource[];
  citationSources: CitationSourceRef[];
  stepStartedAt: number;
  /** Check again: evaluate only tagged claims and the recorded unchecked ones. */
  recheck?: { uncheckedKeys?: readonly string[]; legacyUnchecked?: boolean };
}): Promise<{ markdown: string; meta: StudyDocumentMeta }> {
  // Without any source text (legacy packs) there is nothing to ground against.
  if (args.sources.length === 0) {
    return { markdown: args.markdown, meta: { citationSources: args.citationSources } };
  }
  const { markdown, report } = await groundDocument({
    markdown: args.markdown,
    sources: args.sources,
    maxVerifyItems: MAX_GROUNDING_VERIFY_ITEMS,
    maxEvidenceChars: MAX_GROUNDING_EVIDENCE_CHARS,
    ...(args.recheck ? { recheck: args.recheck } : {}),
    verify: async (items) => {
      const remaining = args.stepStartedAt + GROUNDED_STEP_TOTAL_MS - Date.now();
      const deadlineMs = Math.min(GROUNDING_VERIFY_DEADLINE_MS, remaining);
      if (deadlineMs < MIN_GROUNDING_VERIFY_MS) {
        throw new GenerationError("timeout", "No time left to verify grounding.", false);
      }
      return verifyGroundingItems(items, deadlineMs);
    },
  });
  return { markdown, meta: { citationSources: args.citationSources, grounding: report } };
}

/**
 * Check again: re-check a saved study document against its uploads. Only
 * claims tagged unsourced and the claims the previous report recorded as
 * unchecked are evaluated; any other untagged claim is never newly tagged.
 * Reports written before unchecked keys existed re-check every untagged
 * lexical miss instead. The returned report describes the whole document:
 * this pass's counts, with the supported totals added to the previous ones.
 */
export async function regroundStudyDocument(
  markdown: string,
  sources: GroundingSource[],
  options: { previous?: GroundingReport | null } = {},
): Promise<{ markdown: string; report: GroundingReport | null }> {
  const previous = options.previous ?? null;
  const grounded = await groundGeneratedDocument({
    markdown,
    sources,
    citationSources: [],
    stepStartedAt: Date.now(),
    recheck: {
      uncheckedKeys: previous?.uncheckedKeys,
      legacyUnchecked: !previous?.uncheckedKeys && (previous?.unchecked ?? 0) > 0,
    },
  });
  const pass = grounded.meta.grounding;
  if (!pass) return { markdown: grounded.markdown, report: null };
  // Unchecked counts and keys come only from this pass.
  const carried: Partial<GroundingReport> = { ...previous };
  delete carried.unchecked;
  delete carried.uncheckedKeys;
  // Term guard tags are re-evaluated with every tagged claim, like unsourced.
  delete carried.termFlagged;
  const report: GroundingReport = {
    ...carried,
    total: pass.total,
    cited: pass.cited,
    unsourced: pass.unsourced,
    truncated: pass.truncated,
    verifierFailed: pass.verifierFailed,
    lexicalSupported: (previous?.lexicalSupported ?? 0) + pass.lexicalSupported,
    verifiedSupported: (previous?.verifiedSupported ?? 0) + pass.verifiedSupported,
    ...(pass.termFlagged ? { termFlagged: pass.termFlagged } : {}),
    ...(pass.unchecked ? { unchecked: pass.unchecked } : {}),
    ...(pass.uncheckedKeys?.length ? { uncheckedKeys: pass.uncheckedKeys } : {}),
  };
  return { markdown: grounded.markdown, report };
}

function withKnownCitations<T extends Record<K, string>, K extends keyof T>(
  items: T[],
  key: K,
  sourceCount: number,
): T[] {
  return items.map((item) => {
    const cleaned = dropUnknownSourceCitations(item[key], sourceCount)
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    return cleaned ? ({ ...item, [key]: cleaned } as T) : item;
  });
}

export type StudyPackStepPayload =
  | { kind: "locked_in"; content: string }
  | { kind: "summary"; content: string }
  | { kind: "test_me"; content: TestMeItem[] }
  | { kind: "carded"; content: CardedItem[] };

export type GeneratedStudyPackStep = {
  step: StudyPackStep;
  payload: StudyPackStepPayload;
  modelUsed: string;
  /** Citation identities and grounding report; set for Locked In and Summary. */
  meta?: StudyDocumentMeta;
};

export type StudyPackSourceText = { filename: string; text: string; sourceId?: string };

/** Framing removal left nothing: a failed attempt, never an empty saved document. */
function emptyStudyContentError(): GenerationError {
  return new GenerationError("unavailable", "The model returned no study content. Try again.", true);
}

/** Time kept at the end of the Summary step for grounding's verifier call. */
const SUMMARY_GROUNDING_RESERVE_MS = GROUNDING_VERIFY_DEADLINE_MS;
/**
 * A Summary half's one retry needs this much request time left: 100 s of the
 * 285 s step minus the grounding reserve.
 */
const SUMMARY_RETRY_MIN_MS = 40_000;
/** A Summary half longer than this share of its Locked In half is capped in code. */
const SUMMARY_HALF_MAX_RATIO = 0.55;
/** Summary length aimed for: about 40% of Locked In. */
const SUMMARY_RATIO = 0.4;
/** Characters one Summary bullet stands for when setting bullet limits. */
const SUMMARY_CHARS_PER_BULLET = 260;

/** Per "##" section bullet ceilings: about 40% of the section at 260 characters a bullet, 2 to 14. */
function summaryBulletLimits(half: string): Array<{ heading: string; bullets: number }> {
  return splitSections(half).sections.map((section) => ({
    heading: section.heading,
    bullets: Math.min(14, Math.max(2, Math.round((section.markdown.length * SUMMARY_RATIO) / SUMMARY_CHARS_PER_BULLET))),
  }));
}

/**
 * One Summary part. A cut-off answer is retried once with the strict prompt
 * when at least 100 s of the step remain; a part still cut off fails the step
 * so it is never saved. A complete part longer than 55% of its input is capped
 * in code (capSummarySections) with no extra request: the free model ignored
 * the strict retry and copied Locked In again. Every request ends before the
 * time kept for grounding.
 */
async function summarizeHalf(
  half: string,
  options: { part: 1 | 2; parts: 1 | 2; stepStartedAt: number },
): Promise<{ text: string; modelUsed: string }> {
  const requestTimeLeft = () => Math.min(
    GENERATION_STEP_DEADLINE_MS,
    options.stepStartedAt + GROUNDED_STEP_TOTAL_MS - SUMMARY_GROUNDING_RESERVE_MS - Date.now(),
  );
  const request = (strict: boolean, deadlineMs: number) => {
    const prompt = summaryHalfPrompt(half, {
      part: options.part,
      parts: options.parts,
      bulletLimits: summaryBulletLimits(half),
      targetChars: Math.round(half.length * SUMMARY_RATIO),
      ...(strict ? { strict } : {}),
    });
    return generateTextFromPrompt(prompt, {
      purpose: "summary",
      sourceTokens: estimateTokensFromText(prompt),
      deadlineMs,
    });
  };
  let result = await request(false, requestTimeLeft());
  if (result.finishReason === "length") {
    const timeLeft = requestTimeLeft();
    if (timeLeft >= SUMMARY_RETRY_MIN_MS) result = await request(true, timeLeft);
  }
  if (result.finishReason === "length") {
    throw new GenerationError("token_limit", "Summary was cut off. Try again.", false);
  }
  const text = result.text.length > SUMMARY_HALF_MAX_RATIO * half.length
    ? capSummarySections(result.text, summaryBulletLimits(half))
    : result.text;
  return { text, modelUsed: result.modelUsed };
}

/**
 * The Summary from Locked In: one request per balanced half, in parallel,
 * joined in order. Framing sentences and heading numbering or citations are
 * removed in code, since the free model writes them despite the prompt rules.
 */
async function summarizeLockedIn(
  lockedIn: string,
  stepStartedAt: number,
): Promise<{ text: string; modelUsed: string }> {
  const halves = balancedHalves(lockedIn);
  const parts = halves.length === 2 ? 2 : 1;
  const results = await Promise.all(halves.map((half, index) =>
    summarizeHalf(half, { part: index === 0 ? 1 : 2, parts, stepStartedAt })));
  const joined = results.map((result) => result.text).join("\n\n");
  const text = sanitizeStudyHeadings(stripDocumentFraming(joined));
  if (!text.trim()) throw emptyStudyContentError();
  return { text, modelUsed: results[0].modelUsed };
}

/**
 * Generate one pipeline step. Keeping this operation step-sized is important
 * for route handlers: a request can claim one lease and make one logical
 * provider operation, then persist before the next request resumes the run.
 */
export async function generateStudyPackStep(input: {
  step: StudyPackStep;
  /** Sources in citation order; entry i is cited as S<i+1>. */
  extractedTexts?: StudyPackSourceText[];
  /** Identity of each S<n>; derived from extractedTexts when omitted. */
  citationSources?: CitationSourceRef[];
  /** Summary evidence: the pack's source texts by S<n> index. */
  groundingSources?: GroundingSource[];
  lockedIn?: string;
  summary?: string;
}): Promise<GeneratedStudyPackStep> {
  const stepStartedAt = Date.now();
  switch (input.step) {
    case "locked_in": {
      if (!input.extractedTexts?.length) {
        throw new Error("locked_in generation requires extracted texts");
      }
      const result = await generateTextFromPrompt(
        lockedInPrompt(input.extractedTexts),
        { purpose: "locked_in" },
      );
      // A truncated Locked In would feed every other mode, so it is never saved.
      if (result.finishReason === "length") {
        throw new GenerationError("token_limit", "Locked In was cut off. Try again.", false);
      }
      // Framing is removed in code: the free model writes "This guide..." despite the prompt rule.
      const lockedIn = stripDocumentFraming(result.text);
      if (!lockedIn.trim()) throw emptyStudyContentError();
      const grounded = await groundGeneratedDocument({
        markdown: lockedIn,
        sources: input.extractedTexts.map((source, i) => ({ index: i + 1, text: source.text })),
        citationSources: input.citationSources ?? citationSourcesFor(input.extractedTexts),
        stepStartedAt,
      });
      return {
        step: "locked_in",
        payload: { kind: "locked_in", content: grounded.markdown },
        modelUsed: result.modelUsed,
        meta: grounded.meta,
      };
    }
    case "summary": {
      const lockedIn = input.lockedIn?.trim();
      if (!lockedIn) throw new Error("summary generation requires Locked In");
      const result = await summarizeLockedIn(lockedIn, stepStartedAt);
      const grounded = await groundGeneratedDocument({
        markdown: result.text,
        sources: input.groundingSources ?? [],
        citationSources: input.citationSources ?? [],
        stepStartedAt,
      });
      return {
        step: "summary",
        payload: { kind: "summary", content: grounded.markdown },
        modelUsed: result.modelUsed,
        meta: grounded.meta,
      };
    }
    case "test_me": {
      const lockedIn = input.lockedIn?.trim();
      if (!lockedIn) throw new Error("test_me generation requires Locked In");
      const result = await runTestMe(lockedIn);
      return {
        step: "test_me",
        payload: {
          kind: "test_me",
          content: withKnownCitations(result.items, "explanation", input.citationSources?.length ?? 0),
        },
        modelUsed: result.modelUsed,
      };
    }
    case "carded": {
      const summary = input.summary?.trim();
      if (!summary) throw new Error("carded generation requires Summary");
      const result = await runCarded(summary);
      return {
        step: "carded",
        payload: {
          kind: "carded",
          content: withKnownCitations(result.items, "back", input.citationSources?.length ?? 0),
        },
        modelUsed: result.modelUsed,
      };
    }
  }
}

/**
 * Content id for a generated item: prefix plus the 8-hex FNV-1a 32-bit hash
 * of its prompt text with citations removed, whitespace collapsed and
 * lowercased. Cards are stored by id and keep their schedule, and quiz
 * attempts feed mastery by id, so a Redo item must never inherit an
 * unrelated item's state through a positional id such as "c1".
 */
function stableItemId(prefix: "q" | "c", text: string): string {
  const normalized = text.replace(citationPattern(), " ").replace(/\s+/g, " ").trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Test Me or Carded items from one request per balanced half of the document,
 * sent in parallel. Each half gets its share of the page-scaled target, so the
 * later sections are covered even when the model favours the opening ones.
 * Items are merged in half order, given content ids (stableItemId), with a
 * repeated id dropped, then capped at the total. A half that fails after its retries fails the whole step. A document
 * with one "##" section is a single request with the whole target.
 *
 * Sections that no item cites (uncoveredSections) then get one request per
 * uncovered section, up to 3, in parallel and through the same model chain,
 * when enough of the 270 s step is left. With more than 3, the sections citing
 * the most pages are chosen. A single joined request was seen writing every
 * item about the first section. Top-up items are kept when the result is
 * capped at 120% of the target, and the base items dropped first are those
 * whose pages other kept items still cite. A failed section top-up is skipped.
 */
async function generateItemsByHalves<T extends { id: string }>(args: {
  kind: "test_me" | "carded";
  markdown: string;
  prompt: (markdown: string, maxItems: number) => string;
  elementSchema: z.ZodType<T>;
  /** The item's prompt text: the Test Me question or the Carded front. */
  promptText: (item: T) => string;
  /** All of the item's text, citations included, for section coverage. */
  textOf: (item: T) => string;
}): Promise<{ items: T[]; modelUsed: string }> {
  const startedAt = Date.now();
  const total = studyItemTarget(args.kind, args.markdown);
  const halves = balancedHalves(args.markdown);
  const counts = allocateItems(total, halves);
  const requests = halves.flatMap((half, index) =>
    counts[index] > 0 ? [{ half, count: counts[index] }] : []);
  const results = await Promise.all(requests.map(({ half, count }) => generateJsonArray({
    kind: args.kind,
    prompt: args.prompt(half, count),
    elementSchema: args.elementSchema,
    maxItems: count,
  })));
  const prefix = args.kind === "test_me" ? "q" : "c";
  /** Items with content ids, dropping any id already in `seen` or repeated. */
  const withIds = (generated: T[], seen: Set<string>): T[] => generated.flatMap((item) => {
    const id = stableItemId(prefix, args.promptText(item));
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ ...item, id }];
  });
  const items = withIds(results.flatMap((result) => result.items), new Set()).slice(0, total);
  const modelUsed = results[0].modelUsed;

  const uncovered = uncoveredSections(args.markdown, items, args.textOf);
  if (uncovered.length === 0) return { items, modelUsed };
  const timeLeft = startedAt + GENERATION_STEP_DEADLINE_MS - TOP_UP_SAFETY_MS - Date.now();
  if (timeLeft < TOP_UP_MIN_MS) return { items, modelUsed };
  const settled = await Promise.allSettled(topUpSections(args.markdown, uncovered).map((section) =>
    generateJsonArray({
      kind: args.kind,
      prompt: args.prompt(section.markdown, 1),
      elementSchema: args.elementSchema,
      maxItems: 1,
      deadlineMs: timeLeft,
    })));
  // Coverage is a bonus on top of a usable set; a failed section is skipped.
  const generated = settled.flatMap((result) => (result.status === "fulfilled" ? result.value.items : []));
  const topUp = withIds(generated, new Set(items.map((item) => item.id)));
  if (topUp.length === 0) return { items, modelUsed };
  const cap = Math.ceil(total * 1.2);
  const keptTopUp = topUp.slice(0, cap);
  const keptBase = trimKeepingCoverage(items, cap - keptTopUp.length, keptTopUp, args.textOf);
  return { items: [...keptBase, ...keptTopUp], modelUsed };
}

/** Top-up requests per Test Me or Carded step, one per uncovered section. */
const MAX_TOP_UP_REQUESTS = 3;

/**
 * Up to MAX_TOP_UP_REQUESTS uncovered sections, preferring those citing the
 * most pages, in document order.
 */
function topUpSections(
  markdown: string,
  uncovered: ReadonlyArray<{ heading: string; markdown: string }>,
): Array<{ heading: string; markdown: string }> {
  if (uncovered.length <= MAX_TOP_UP_REQUESTS) return [...uncovered];
  const sections = sectionPages(markdown);
  const pagesOf = (section: { heading: string; markdown: string }) => sections.find((candidate) =>
    candidate.heading === section.heading && candidate.markdown === section.markdown)?.pages.size ?? 0;
  const chosen = new Set(uncovered
    .map((section, index) => ({ index, pages: pagesOf(section) }))
    .sort((a, b) => b.pages - a.pages || a.index - b.index)
    .slice(0, MAX_TOP_UP_REQUESTS)
    .map(({ index }) => index));
  return uncovered.filter((_, index) => chosen.has(index));
}

/** The top-up runs only with this much of the item step left, after the safety margin. */
const TOP_UP_MIN_MS = 45_000;
/** Kept between the top-up's deadline and the end of the item step. */
const TOP_UP_SAFETY_MS = 10_000;

/**
 * Base items cut down to `keep`, dropping from the end first those whose cited
 * pages are all still cited by another kept item (base or top-up), so the trim
 * does not uncover a section. When that is not enough, the last remaining
 * items go.
 */
function trimKeepingCoverage<T>(
  base: readonly T[],
  keep: number,
  others: readonly T[],
  textOf: (item: T) => string,
): T[] {
  const kept = [...base];
  if (kept.length <= keep) return kept;
  const pages = kept.map((item) => itemPages(textOf(item)));
  const pageCounts = new Map<number, number>();
  for (const set of [...pages, ...others.map((item) => itemPages(textOf(item)))]) {
    for (const page of set) pageCounts.set(page, (pageCounts.get(page) ?? 0) + 1);
  }
  for (let index = kept.length - 1; index >= 0 && kept.length > keep; index--) {
    if ([...pages[index]].every((page) => (pageCounts.get(page) ?? 0) > 1)) {
      for (const page of pages[index]) pageCounts.set(page, pageCounts.get(page)! - 1);
      kept.splice(index, 1);
      pages.splice(index, 1);
    }
  }
  return kept.slice(0, keep);
}

/** A question's full text for coverage, citations included. */
function testMeText(item: TestMeItem): string {
  return [item.question, item.explanation, item.answer].join("\n");
}

/** A card's full text for coverage, citations included. */
function cardedText(item: CardedItem): string {
  return [item.front, item.back].join("\n");
}

async function runTestMe(lockedIn: string): Promise<{ items: TestMeItem[]; modelUsed: string }> {
  try {
    const result = await generateItemsByHalves({
      kind: "test_me",
      markdown: lockedIn,
      prompt: testMePrompt,
      elementSchema: testMeWireItemSchema,
      promptText: (item) => item.question,
      textOf: testMeText,
    });
    // Valid items can still carry "A. ..." labels; the UI numbers choices.
    return { ...result, items: result.items.map((item) => repairQuizAnswer(item) as TestMeItem) };
  } catch (err) {
    if (err instanceof PromptInputLimitError) throw err;
    throw toGenerationError(
      err instanceof StudyPackJsonError
        ? err
        : new StudyPackJsonError(
            "test_me",
            err instanceof Error ? err.message : "test_me failed",
            "",
          ),
    );
  }
}

async function runCarded(summary: string): Promise<{ items: CardedItem[]; modelUsed: string }> {
  try {
    return await generateItemsByHalves({
      kind: "carded",
      markdown: summary,
      prompt: cardedPrompt,
      elementSchema: cardedItemSchema,
      promptText: (item) => item.front,
      textOf: cardedText,
    });
  } catch (err) {
    if (err instanceof PromptInputLimitError) throw err;
    throw toGenerationError(
      err instanceof StudyPackJsonError
        ? err
        : new StudyPackJsonError(
            "carded",
            err instanceof Error ? err.message : "carded failed",
            "",
          ),
    );
  }
}

/**
 * Sequential study-pack pipeline:
 * Locked In (sources) → Summary (Locked In) → Test Me (Locked In) → Carded (Summary).
 * Calls onStep after each successful step so the route can persist immediately.
 */
export async function generateStudyPack(input: {
  extractedTexts: StudyPackSourceText[];
  onStep?: (event: GeneratedStudyPackStep) => void | Promise<void>;
}): Promise<{
  lockedIn: string;
  summary: string;
  testMe: TestMeItem[];
  carded: CardedItem[];
  models: Partial<Record<StudyPackStep, string>>;
  meta: { lockedIn: StudyDocumentMeta; summary: StudyDocumentMeta };
}> {
  if (input.extractedTexts.length === 0) {
    throw new Error("generateStudyPack requires at least one extracted text");
  }

  const models: Partial<Record<StudyPackStep, string>> = {};
  const citationSources = citationSourcesFor(input.extractedTexts);
  const groundingSources = input.extractedTexts.map((source, i) => ({ index: i + 1, text: source.text }));

  const run = async (
    step: StudyPackStep,
    upstream: { lockedIn?: string; summary?: string },
  ): Promise<GeneratedStudyPackStep> => {
    const result = await generateStudyPackStep({
      step,
      extractedTexts: input.extractedTexts,
      citationSources,
      groundingSources,
      ...upstream,
    });
    models[step] = result.modelUsed;
    await input.onStep?.(result);
    return result;
  };

  const lockedInStep = await run("locked_in", {});
  const lockedIn = lockedInStep.payload.content as string;
  const summaryStep = await run("summary", { lockedIn });
  const summary = summaryStep.payload.content as string;
  const testMeStep = await run("test_me", { lockedIn });
  const cardedStep = await run("carded", { summary });

  return {
    lockedIn,
    summary,
    testMe: testMeStep.payload.content as TestMeItem[],
    carded: cardedStep.payload.content as CardedItem[],
    models,
    meta: {
      lockedIn: lockedInStep.meta ?? { citationSources },
      summary: summaryStep.meta ?? { citationSources },
    },
  };
}

export async function generateLockedIn(
  extractedTexts: { filename: string; text: string }[],
): Promise<string> {
  const result = await generateTextFromPrompt(lockedInPrompt(extractedTexts), {
    purpose: "locked_in",
  });
  return result.text;
}

export async function generateSummary(lockedInMarkdown: string): Promise<string> {
  const result = await summarizeLockedIn(lockedInMarkdown.trim(), Date.now());
  return result.text;
}

export async function generateTestMe(
  lockedInMarkdown: string,
): Promise<TestMeItem[]> {
  const result = await generateItemsByHalves({
    kind: "test_me",
    markdown: lockedInMarkdown,
    prompt: testMePrompt,
    elementSchema: testMeWireItemSchema,
    promptText: (item) => item.question,
    textOf: testMeText,
  });
  return result.items;
}

export async function generateCarded(
  summaryMarkdown: string,
): Promise<CardedItem[]> {
  const result = await generateItemsByHalves({
    kind: "carded",
    markdown: summaryMarkdown,
    prompt: cardedPrompt,
    elementSchema: cardedItemSchema,
    promptText: (item) => item.front,
    textOf: cardedText,
  });
  return result.items;
}

/** Ask answers must finish inside the route's 120 s function limit. */
export const ASK_DEADLINE_MS = 90_000;

/** Room kept for page labels and joins the prompt adds around each source. */
const ASK_PROMPT_SLACK_CHARS = 2_000;
const ASK_PER_SOURCE_SLACK_CHARS = 200;

/**
 * Characters of source text Ask may send: the model's context window minus
 * the answer, the safety margin and the rest of the prompt (instructions,
 * history, question), capped by the combined source limit.
 */
export function askSourceCharBudget(args: {
  sources: readonly AskSourceInput[];
  history: readonly AskHistoryMessage[];
  question: string;
}): number {
  const windowTokens = contextWindowForRequest(modelIdForPurpose("ask"));
  const promptTokens = Math.min(windowTokens, PROMPT_LIMITS.maxPromptTokens) -
    ASK_OUTPUT_TOKENS - GENERATION_CONTEXT_SAFETY_MARGIN_TOKENS;
  const frame = buildAskPrompt({
    sources: args.sources.map((source) => ({ ...source, text: "" })),
    history: args.history,
    question: args.question,
  });
  const overhead = frame.length + ASK_PROMPT_SLACK_CHARS + args.sources.length * ASK_PER_SOURCE_SLACK_CHARS;
  return Math.max(0, Math.min(PROMPT_LIMITS.maxCombinedSourceChars, promptTokens * 4 - overhead));
}

export type AskAnswer = {
  markdown: string;
  refused: boolean;
  citationSources: CitationSourceRef[];
  pagesSent: AskPagesSent;
  modelUsed: string;
};

/**
 * Answer a question from the pack's own sources in one model request. The
 * answer is grounded with the text check only; the verifier is never called.
 * A refusal is returned as written, without grounding tags.
 */
export async function answerFromPack(args: {
  /** Pack sources in citation order; entry i is cited as S<i+1>. */
  sources: readonly AskSourceInput[];
  history: readonly AskHistoryMessage[];
  question: string;
  /** Text the pages are ranked against; defaults to the question. */
  rankingText?: string;
  signal?: AbortSignal;
}): Promise<AskAnswer> {
  const budgetChars = askSourceCharBudget(args);
  const { texts, pagesSent } = selectAskSources(args.sources, args.rankingText ?? args.question, budgetChars);
  const prompt = buildAskPrompt({ sources: texts, history: args.history, question: args.question });
  const { text, modelUsed } = await generateTextFromPrompt(prompt, {
    purpose: "ask",
    signal: args.signal,
    deadlineMs: ASK_DEADLINE_MS,
  });
  const parsed = parseAskAnswer(text, args.sources.length);
  const citationSources = citationSourcesFor(args.sources);
  if (!parsed.refused && !parsed.markdown) {
    throw new GenerationError("unavailable", "The model returned no answer text. Try again.", true);
  }
  if (parsed.refused) {
    return { markdown: parsed.markdown, refused: parsed.refused, citationSources, pagesSent, modelUsed };
  }
  const grounded = await groundAnswer(
    parsed.markdown,
    texts.map((source, i) => ({ index: i + 1, text: source.text })),
  );
  return { markdown: grounded.markdown, refused: false, citationSources, pagesSent, modelUsed };
}

export const ASK_FREE_LIMIT_MESSAGE = "The free model limit is used up for now. Try again later today.";

/**
 * The authored message and status for a failed Ask request. A provider 429
 * means the free quota is spent; everything else uses the generation wording.
 */
export function publicAskError(error: unknown): { message: string; status: number } {
  const classified = toGenerationError(error);
  switch (classified.code) {
    case "rate_limited":
      return { message: ASK_FREE_LIMIT_MESSAGE, status: 429 };
    case "timeout":
      return { message: "The answer took too long. Try again in a moment.", status: 504 };
    case "token_limit":
      return { message: "This question is too long for the model with your sources. Try a shorter question.", status: 413 };
    default:
      return {
        message: publicGenerationErrorMessage(classified.code, classified.message) ?? "Ask failed. Try again shortly.",
        status: 502,
      };
  }
}

export { GenerationError };
