import "server-only";

import { generateObject, generateText, NoObjectGeneratedError } from "ai";
import { z } from "zod";

import {
  GenerationError,
  toGenerationError,
} from "@/lib/generation-errors";
import { getEnv } from "@/lib/env";
import { getOpenRouterModel } from "@/lib/openrouter";
import { isValidCardFront, normalizeLearningIds } from "@/lib/learning";
import {
  MAX_CARD_BACK_CHARS,
  MAX_CARD_FRONT_CHARS,
  MAX_CARDED_ITEMS,
  MAX_GENERATED_JSON_CHARS,
  MAX_GENERATED_MARKDOWN_CHARS,
  MAX_GENERATION_JSON_OUTPUT_TOKENS,
  MAX_GENERATION_TEXT_OUTPUT_TOKENS,
  MAX_LEARNING_ID_CHARS,
  MAX_TEST_ME_ANSWER_CHARS,
  MAX_TEST_ME_CHOICE_CHARS,
  MAX_TEST_ME_CHOICES,
  MAX_TEST_ME_EXPLANATION_CHARS,
  MAX_TEST_ME_ITEMS,
  MAX_TEST_ME_QUESTION_CHARS,
  MAX_VISION_OUTPUT_TOKENS,
  MAX_VISION_TEXT_CHARS,
} from "@/lib/learning-limits";
import {
  PromptInputLimitError,
  assertPromptWithinLimit,
  cardedPrompt,
  lockedInPrompt,
  summaryPrompt,
  testMePrompt,
} from "@/lib/prompts";
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

const MAX_ATTEMPTS = 3;

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
    return Promise.reject(new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jitterDelay(attempt: number): number {
  const base = 400 * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classified = toGenerationError(err);
      if (!classified.retryable || attempt === MAX_ATTEMPTS) {
        throw classified;
      }
      await sleep(jitterDelay(attempt), signal);
    }
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
  options: { purpose: GenerationPurpose; signal?: AbortSignal } = { purpose: "locked_in" },
): Promise<{ text: string; modelUsed: string }> {
  assertPromptWithinLimit(prompt);
  const modelId = modelIdForPurpose(options.purpose);
  const healJson = options.purpose === "json";

  return withRetry(async () => {
    const { text, response, providerMetadata } = await generateText({
      model: getOpenRouterModel(modelId, { healJson }),
      prompt,
      maxOutputTokens: options.purpose === "json"
        ? MAX_GENERATION_JSON_OUTPUT_TOKENS
        : MAX_GENERATION_TEXT_OUTPUT_TOKENS,
      abortSignal: options.signal,
    });
    const normalizedText = text.trim();
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
  }, options.signal);
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

  const result = await withRetry(async () => {
    const { text } = await generateText({
      model: getOpenRouterModel(modelId),
      abortSignal: options.signal,
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
  }, options.signal);

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
  if (!Array.isArray(parsed)) {
    throw new SyntaxError("Expected a JSON array");
  }
  return parsed;
}

function tryParseJsonArrayLocally<T extends { id: string }>(
  elementSchema: z.ZodType<T>,
  raw: string,
  maxItems: number,
): T[] | null {
  if (!raw.trim()) return null;
  try {
    return elementSchema.array().max(maxItems).parse(parseJsonArray(raw));
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
): { items: T[]; raw: string } {
  const maxItems = kind === "test_me" ? MAX_TEST_ME_ITEMS : MAX_CARDED_ITEMS;
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
  const maxItems = args.kind === "test_me" ? MAX_TEST_ME_ITEMS : MAX_CARDED_ITEMS;
  let lastRaw = "";

  try {
    return await withRetry(async () => {
      try {
        const result = await generateObject({
          model: getOpenRouterModel(modelId, { healJson: true }),
          output: "array",
          schema: args.elementSchema,
          prompt: args.prompt,
          maxOutputTokens: MAX_GENERATION_JSON_OUTPUT_TOKENS,
        });
        const normalized = normalizeGeneratedItems(args.kind, result.object as T[]);
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
            const normalized = normalizeGeneratedItems(args.kind, parsed);
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
    });
  } catch (objectError) {
    const parsed = tryParseJsonArrayLocally(args.elementSchema, lastRaw, maxItems);
    if (parsed) {
      const normalized = normalizeGeneratedItems(args.kind, parsed);
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

export type StudyPackStepPayload =
  | { kind: "locked_in"; content: string }
  | { kind: "summary"; content: string }
  | { kind: "test_me"; content: TestMeItem[] }
  | { kind: "carded"; content: CardedItem[] };

export type GeneratedStudyPackStep = {
  step: StudyPackStep;
  payload: StudyPackStepPayload;
  modelUsed: string;
};

/**
 * Generate one pipeline step. Keeping this operation step-sized is important
 * for route handlers: a request can claim one lease and make one logical
 * provider operation, then persist before the next request resumes the run.
 */
export async function generateStudyPackStep(input: {
  step: StudyPackStep;
  extractedTexts?: { filename: string; text: string }[];
  lockedIn?: string;
  summary?: string;
}): Promise<GeneratedStudyPackStep> {
  switch (input.step) {
    case "locked_in": {
      if (!input.extractedTexts?.length) {
        throw new Error("locked_in generation requires extracted texts");
      }
      const result = await generateTextFromPrompt(
        lockedInPrompt(input.extractedTexts),
        { purpose: "locked_in" },
      );
      return {
        step: "locked_in",
        payload: { kind: "locked_in", content: result.text },
        modelUsed: result.modelUsed,
      };
    }
    case "summary": {
      const lockedIn = input.lockedIn?.trim();
      if (!lockedIn) throw new Error("summary generation requires Locked In");
      const result = await generateTextFromPrompt(summaryPrompt(lockedIn), {
        purpose: "summary",
      });
      return {
        step: "summary",
        payload: { kind: "summary", content: result.text },
        modelUsed: result.modelUsed,
      };
    }
    case "test_me": {
      const lockedIn = input.lockedIn?.trim();
      if (!lockedIn) throw new Error("test_me generation requires Locked In");
      try {
        const result = await generateJsonArray({
          kind: "test_me",
          prompt: testMePrompt(lockedIn),
          elementSchema: testMeItemSchema,
        });
        return {
          step: "test_me",
          payload: { kind: "test_me", content: result.items },
          modelUsed: result.modelUsed,
        };
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
    case "carded": {
      const summary = input.summary?.trim();
      if (!summary) throw new Error("carded generation requires Summary");
      try {
        const result = await generateJsonArray({
          kind: "carded",
          prompt: cardedPrompt(summary),
          elementSchema: cardedItemSchema,
        });
        return {
          step: "carded",
          payload: { kind: "carded", content: result.items },
          modelUsed: result.modelUsed,
        };
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
  }
}

/**
 * Sequential study-pack pipeline:
 * Locked In (sources) → Summary (Locked In) → Test Me (Locked In) → Carded (Summary).
 * Calls onStep after each successful step so the route can persist immediately.
 */
export async function generateStudyPack(input: {
  extractedTexts: { filename: string; text: string }[];
  onStep?: (event: {
    step: StudyPackStep;
    payload: StudyPackStepPayload;
    modelUsed: string;
  }) => void | Promise<void>;
}): Promise<{
  lockedIn: string;
  summary: string;
  testMe: TestMeItem[];
  carded: CardedItem[];
  models: Partial<Record<StudyPackStep, string>>;
}> {
  if (input.extractedTexts.length === 0) {
    throw new Error("generateStudyPack requires at least one extracted text");
  }

  const models: Partial<Record<StudyPackStep, string>> = {};

  const lockedInResult = await generateTextFromPrompt(
    lockedInPrompt(input.extractedTexts),
    { purpose: "locked_in" },
  );
  models.locked_in = lockedInResult.modelUsed;
  await input.onStep?.({
    step: "locked_in",
    payload: { kind: "locked_in", content: lockedInResult.text },
    modelUsed: lockedInResult.modelUsed,
  });

  const summaryResult = await generateTextFromPrompt(
    summaryPrompt(lockedInResult.text),
    { purpose: "summary" },
  );
  models.summary = summaryResult.modelUsed;
  await input.onStep?.({
    step: "summary",
    payload: { kind: "summary", content: summaryResult.text },
    modelUsed: summaryResult.modelUsed,
  });

  let testMe: TestMeItem[];
  let testMeModel: string;
  try {
    const testMeResult = await generateJsonArray({
      kind: "test_me",
      prompt: testMePrompt(lockedInResult.text),
      elementSchema: testMeItemSchema,
    });
    testMe = testMeResult.items;
    testMeModel = testMeResult.modelUsed;
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
  models.test_me = testMeModel;
  await input.onStep?.({
    step: "test_me",
    payload: { kind: "test_me", content: testMe },
    modelUsed: testMeModel,
  });

  let carded: CardedItem[];
  let cardedModel: string;
  try {
    const cardedResult = await generateJsonArray({
      kind: "carded",
      prompt: cardedPrompt(summaryResult.text),
      elementSchema: cardedItemSchema,
    });
    carded = cardedResult.items;
    cardedModel = cardedResult.modelUsed;
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
  models.carded = cardedModel;
  await input.onStep?.({
    step: "carded",
    payload: { kind: "carded", content: carded },
    modelUsed: cardedModel,
  });

  return {
    lockedIn: lockedInResult.text,
    summary: summaryResult.text,
    testMe,
    carded,
    models,
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
