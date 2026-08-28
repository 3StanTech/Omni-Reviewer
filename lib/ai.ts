import "server-only";

import { generateObject, generateText, NoObjectGeneratedError } from "ai";
import { z } from "zod";

import {
  GenerationError,
  toGenerationError,
} from "@/lib/generation-errors";
import { getOpenRouterModel } from "@/lib/openrouter";
import {
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

const testMeItemSchema = z.object({
  id: z.string(),
  question: z.string(),
  choices: z.array(z.string()).optional(),
  answer: z.string(),
  explanation: z.string(),
});

const cardedItemSchema = z.object({
  id: z.string(),
  front: z.string(),
  back: z.string(),
});

const MAX_ATTEMPTS = 3;

function modelIdForPurpose(purpose: GenerationPurpose): string {
  switch (purpose) {
    case "locked_in":
      return (
        process.env.AI_MODEL_LOCKED_IN ||
        process.env.AI_MODEL ||
        "z-ai/glm-5.2:free"
      );
    case "summary":
      return (
        process.env.AI_MODEL_SUMMARY ||
        process.env.AI_MODEL ||
        "z-ai/glm-5.2:free"
      );
    case "json":
      return (
        process.env.AI_MODEL_JSON ||
        process.env.AI_MODEL ||
        "z-ai/glm-5.2:free"
      );
    case "vision":
      return (
        process.env.AI_MODEL_VISION ||
        process.env.AI_MODEL ||
        "minimax/minimax-m3:free"
      );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterDelay(attempt: number): number {
  const base = 400 * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classified = toGenerationError(err);
      if (!classified.retryable || attempt === MAX_ATTEMPTS) {
        throw classified;
      }
      await sleep(jitterDelay(attempt));
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
  options: { purpose: GenerationPurpose } = { purpose: "locked_in" },
): Promise<{ text: string; modelUsed: string }> {
  const modelId = modelIdForPurpose(options.purpose);
  const healJson = options.purpose === "json";

  return withRetry(async () => {
    const { text, response, providerMetadata } = await generateText({
      model: getOpenRouterModel(modelId, { healJson }),
      prompt,
    });
    return {
      text: text.trim(),
      modelUsed: extractModelUsed({ response, providerMetadata }, modelId),
    };
  });
}

export async function visionReadImages(
  images: { mime: string; bytes: Uint8Array }[],
  instruction: string,
): Promise<string> {
  if (images.length === 0) {
    throw new Error("visionReadImages requires at least one image");
  }

  const modelId = modelIdForPurpose("vision");

  const result = await withRetry(async () => {
    const { text } = await generateText({
      model: getOpenRouterModel(modelId),
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
    return text.trim();
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
  const cleaned = stripJsonFences(raw);
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new SyntaxError("Expected a JSON array");
  }
  return parsed;
}

function tryParseJsonArrayLocally<T>(
  elementSchema: z.ZodType<T>,
  raw: string,
): T[] | null {
  if (!raw.trim()) return null;
  try {
    return elementSchema.array().parse(parseJsonArray(raw));
  } catch {
    return null;
  }
}

async function generateJsonArray<T>(args: {
  kind: "test_me" | "carded";
  prompt: string;
  elementSchema: z.ZodType<T>;
}): Promise<{ items: T[]; modelUsed: string; raw: string }> {
  const modelId = modelIdForPurpose("json");
  let lastRaw = "";

  try {
    return await withRetry(async () => {
      try {
        const result = await generateObject({
          model: getOpenRouterModel(modelId, { healJson: true }),
          output: "array",
          schema: args.elementSchema,
          prompt: args.prompt,
        });
        return {
          items: result.object as T[],
          modelUsed: extractModelUsed(result, modelId),
          raw: JSON.stringify(result.object),
        };
      } catch (err) {
        // Last resort local parse (no extra model call) when healing still fails.
        if (NoObjectGeneratedError.isInstance(err) && err.text) {
          lastRaw = err.text;
          const parsed = tryParseJsonArrayLocally(args.elementSchema, err.text);
          if (parsed) {
            return {
              items: parsed,
              modelUsed: extractModelUsed(
                { response: err.response },
                modelId,
              ),
              raw: err.text,
            };
          }
        }
        throw err;
      }
    });
  } catch (objectError) {
    const parsed = tryParseJsonArrayLocally(args.elementSchema, lastRaw);
    if (parsed) {
      return { items: parsed, modelUsed: modelId, raw: lastRaw };
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
