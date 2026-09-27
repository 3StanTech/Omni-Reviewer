import "server-only";

import { generateObject, generateText, NoObjectGeneratedError } from "ai";
import { z } from "zod";

import {
  assertGenerationBudget,
  estimateTokensFromText,
  generationBudget,
} from "@/lib/ai-budgets";
import {
  dropUnknownSourceCitations,
  type CitationSourceRef,
  type StudyDocumentMeta,
} from "@/lib/citations";
import {
  GenerationError,
  toGenerationError,
} from "@/lib/generation-errors";
import {
  groundDocument,
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
  PromptInputLimitError,
  assertPromptWithinLimit,
  cardedPrompt,
  groundingVerifyPrompt,
  lockedInPrompt,
  summaryPrompt,
  testMePrompt,
} from "@/lib/prompts";
import { hasPageMarkers } from "@/lib/source-markers";
import type { CardedItem, TestMeItem } from "@/lib/types";

export type GenerationPurpose = "locked_in" | "summary" | "json" | "vision";

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
    }
  })
  .strict();

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
  } = { purpose: "locked_in" },
): Promise<{ text: string; modelUsed: string }> {
  assertPromptWithinLimit(prompt);
  const modelId = modelIdForPurpose(options.purpose);
  const healJson = options.purpose === "json";
  const budget = generationBudget(
    options.purpose,
    options.sourceTokens ?? estimateTokensFromText(prompt),
    {
      contextWindowTokens: contextWindowForRequest(modelId),
      attempts: MAX_GENERATION_ATTEMPTS,
      deadlineMs: GENERATION_STEP_DEADLINE_MS,
      safetyMarginTokens: GENERATION_CONTEXT_SAFETY_MARGIN_TOKENS,
    },
  );
  assertGenerationBudget(prompt, budget);

  return withRetry(async (signal) => {
    const { text, response, providerMetadata } = await generateText({
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
    };
  }, {
    signal: options.signal,
    attempts: budget.attempts,
    deadlineMs: budget.deadlineMs,
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

  const modelId = modelIdForPurpose("vision");

  const result = await withRetry(async (signal) => {
    const { text } = await generateText({
      model: getOpenRouterModel(modelId),
      maxRetries: 0,
      abortSignal: signal,
      maxOutputTokens: MAX_VISION_OUTPUT_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            ...images.map((img) => ({
              type: "image" as const,
              image: img.bytes,
              mediaType: img.mime,
            })),
          ],
        },
      ],
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
    signal: options.signal,
    attempts: MAX_GENERATION_ATTEMPTS,
    deadlineMs: GENERATION_STEP_DEADLINE_MS,
  });

  return result;
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

/**
 * A quiz answer must equal one of its choices. Models sometimes answer with a
 * sentence that contains exactly one choice; map that to the choice. Anything
 * ambiguous is left alone so validation drops the item.
 */
export function repairQuizAnswer(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const record = item as { choices?: unknown; answer?: unknown };
  if (!Array.isArray(record.choices) || typeof record.answer !== "string") return item;
  const choices = record.choices.filter((choice): choice is string => typeof choice === "string");
  if (choices.includes(record.answer)) return item;
  const answer = normalizeChoiceText(record.answer);
  const exact = choices.filter((choice) => normalizeChoiceText(choice) === answer);
  const contained = choices.filter((choice) => {
    const normalized = normalizeChoiceText(choice);
    return normalized.length > 0 && (answer.includes(normalized) || normalized.includes(answer));
  });
  const match = exact.length === 1 ? exact[0] : contained.length === 1 ? contained[0] : null;
  return match ? { ...record, answer: match } : item;
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
      deadlineMs: GENERATION_STEP_DEADLINE_MS,
      safetyMarginTokens: GENERATION_CONTEXT_SAFETY_MARGIN_TOKENS,
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
      const grounded = await groundGeneratedDocument({
        markdown: result.text,
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
      const result = await generateTextFromPrompt(summaryPrompt(lockedIn), {
        purpose: "summary",
      });
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

async function runTestMe(lockedIn: string): Promise<{ items: TestMeItem[]; modelUsed: string }> {
  try {
    return await generateJsonArray({
      kind: "test_me",
      prompt: testMePrompt(lockedIn),
      elementSchema: testMeItemSchema,
    });
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
    return await generateJsonArray({
      kind: "carded",
      prompt: cardedPrompt(summary),
      elementSchema: cardedItemSchema,
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
  const result = await generateTextFromPrompt(summaryPrompt(lockedInMarkdown), {
    purpose: "summary",
  });
  return result.text;
}

export async function generateTestMe(
  lockedInMarkdown: string,
): Promise<TestMeItem[]> {
  const result = await generateJsonArray({
    kind: "test_me",
    prompt: testMePrompt(lockedInMarkdown),
    elementSchema: testMeItemSchema,
  });
  return result.items;
}

export async function generateCarded(
  summaryMarkdown: string,
): Promise<CardedItem[]> {
  const result = await generateJsonArray({
    kind: "carded",
    prompt: cardedPrompt(summaryMarkdown),
    elementSchema: cardedItemSchema,
  });
  return result.items;
}

export { GenerationError };
