import { z } from "zod";

import type { CardedItem, TestMeItem } from "@/lib/types";
import {
  MAX_CARD_BACK_CHARS,
  MAX_CARD_FRONT_CHARS,
  MAX_CARDED_ITEMS,
  MAX_LEARNING_ID_CHARS,
  MAX_TEST_ME_ANSWER_CHARS,
  MAX_TEST_ME_CHOICE_CHARS,
  MAX_TEST_ME_CHOICES,
  MAX_TEST_ME_EXPLANATION_CHARS,
  MAX_TEST_ME_ITEMS,
  MAX_TEST_ME_QUESTION_CHARS,
} from "@/lib/learning-limits";

const testItemSchema = z
  .object({
    // Legacy rows can have a blank id; normalizeLearningIds gives them a
    // deterministic nonempty identity before any caller can use them.
    id: z.string().trim().max(MAX_LEARNING_ID_CHARS),
    question: z.string().trim().min(1).max(MAX_TEST_ME_QUESTION_CHARS),
    // Empty choices were used by the first persisted Test Me pack for
    // open-ended prompts; preserve those as legacy open-ended items.
    choices: z.preprocess(
      (value) => (Array.isArray(value) && value.length === 0 ? undefined : value),
      z.array(z.string().trim().min(1).max(MAX_TEST_ME_CHOICE_CHARS))
        .min(2)
        .max(MAX_TEST_ME_CHOICES)
        .optional(),
    ),
    answer: z.string().trim().min(1).max(MAX_TEST_ME_ANSWER_CHARS),
    explanation: z.string().max(MAX_TEST_ME_EXPLANATION_CHARS),
  })
  .superRefine((item, context) => {
    if (item.choices && !item.choices.includes(item.answer)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: "answer must exactly match one of choices",
      });
    }
  })
  .strict();

export const MAX_CLOZE_TEXT_CHARS = 20_000;
export const MAX_CLOZE_ANSWER_CHARS = 500;
export const MAX_CLOZE_DELETIONS = 50;

const cardItemSchema = z
  .object({
    id: z.string().trim().max(MAX_LEARNING_ID_CHARS),
    front: z.string().trim().min(1).max(MAX_CARD_FRONT_CHARS).optional(),
    back: z.string().trim().min(1).max(MAX_CARD_BACK_CHARS),
    // `kind` and `text` are accepted for forward-compatible generated cloze
    // rows; persisted cards still use front/back as their canonical storage.
    kind: z.enum(["basic", "cloze"]).optional(),
    type: z.enum(["basic", "cloze"]).optional(),
    text: z.string().trim().min(1).max(MAX_CARD_FRONT_CHARS).optional(),
    cloze: z.object({
      text: z.string().trim().min(1).max(MAX_CARD_FRONT_CHARS),
      answers: z.array(z.string().trim().min(1).max(MAX_CLOZE_ANSWER_CHARS)).max(MAX_CLOZE_DELETIONS).optional(),
    }).strict().optional(),
  })
  .strict();

export type ClozeSegment =
  | { kind: "text"; value: string }
  | { kind: "blank"; value: string; index: number };

export type ParsedCloze = {
  source: string;
  segments: ClozeSegment[];
  answers: string[];
};

/** Parse the deliberately small, explicit `{{answer}}` cloze format. */
export function parseClozeText(value: string): ParsedCloze | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CLOZE_TEXT_CHARS) {
    return null;
  }
  if (!value.includes("{{") && !value.includes("}}")) return null;

  const segments: ClozeSegment[] = [];
  const answers: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("{{", cursor);
    const close = value.indexOf("}}", cursor);
    if (close !== -1 && (open === -1 || close < open)) return null;
    if (open === -1) break;

    const end = value.indexOf("}}", open + 2);
    if (end === -1) return null;
    const nested = value.indexOf("{{", open + 2);
    if (nested !== -1 && nested < end) return null;
    const answer = value.slice(open + 2, end).trim();
    if (!answer || answer.length > MAX_CLOZE_ANSWER_CHARS) return null;
    if (open > cursor) {
      segments.push({ kind: "text", value: value.slice(cursor, open) });
    }
    if (answers.length >= MAX_CLOZE_DELETIONS) return null;
    segments.push({ kind: "blank", value: answer, index: answers.length });
    answers.push(answer);
    cursor = end + 2;
  }
  if (answers.length === 0) return null;
  if (cursor < value.length) {
    segments.push({ kind: "text", value: value.slice(cursor) });
  }
  // A stray brace pair is a malformed cloze rather than a basic card. This
  // prevents an editor/model typo from becoming a card with hidden content.
  if (value.indexOf("{{", cursor) !== -1 || value.indexOf("}}", cursor) !== -1) {
    return null;
  }
  return { source: value, segments, answers };
}

export function isClozeCardFront(value: string): boolean {
  return parseClozeText(value) !== null;
}

export function isValidCardFront(value: string): boolean {
  return !(value.includes("{{") || value.includes("}}")) || isClozeCardFront(value);
}

export function renderClozeText(value: string, reveal = false): string {
  const parsed = parseClozeText(value);
  if (!parsed) return value;
  return parsed.segments
    .map((segment) =>
      segment.kind === "text" ? segment.value : reveal ? segment.value : "_____",
    )
    .join("");
}

function normalizeCardItem(item: z.infer<typeof cardItemSchema>): CardedItem | null {
  const explicitKind = item.kind ?? item.type;
  const source = item.cloze?.text ?? item.text ?? item.front ?? "";
  if (!source) return null;
  const cloze = parseClozeText(source);
  if (
    cloze &&
    item.cloze?.answers &&
    (item.cloze.answers.length !== cloze.answers.length ||
      item.cloze.answers.some((answer, index) => answer !== cloze.answers[index]))
  ) {
    return null;
  }
  if (explicitKind === "cloze" && !cloze) return null;
  if (explicitKind === "basic" && (source.includes("{{") || source.includes("}}"))) {
    return null;
  }
  if (!isValidCardFront(source)) return null;
  return { id: item.id, front: source, back: item.back, kind: cloze ? "cloze" : "basic" };
}

function parseJson(contentJson: unknown | null, content: string): unknown {
  if (contentJson !== null && contentJson !== undefined) return contentJson;
  try {
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/** Normalize IDs at every persisted/client parsing boundary. */
export function normalizeLearningIds<T extends { id: string }>(items: T[]): T[] {
  const used = new Set<string>();
  const nextSuffixByBase = new Map<string, number>();
  return items.map((item, index) => {
    const base = item.id.trim() || `item-${index + 1}`;
    let id = base;
    let suffix = nextSuffixByBase.get(base) ?? 2;
    if (used.has(id)) {
      while (used.has(`${base}-${suffix}`)) suffix += 1;
      id = `${base}-${suffix}`;
      nextSuffixByBase.set(base, suffix + 1);
    } else if (!nextSuffixByBase.has(base)) {
      nextSuffixByBase.set(base, 2);
    }
    used.add(id);
    return { ...item, id };
  });
}

export function parseTestMeItems(
  contentJson: unknown | null,
  content: string,
): TestMeItem[] {
  const parsed = parseJson(contentJson, content);
  if (!Array.isArray(parsed)) return [];
  if (parsed.length > MAX_TEST_ME_ITEMS) return [];
  const valid = parsed.flatMap((item) => {
    const result = testItemSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
  const normalized = normalizeLearningIds(valid);
  return normalized.every((item) => item.id.length <= MAX_LEARNING_ID_CHARS)
    ? normalized
    : [];
}

export function parseCardedItems(
  contentJson: unknown | null,
  content: string,
): CardedItem[] {
  const parsed = parseJson(contentJson, content);
  if (!Array.isArray(parsed)) return [];
  if (parsed.length > MAX_CARDED_ITEMS) return [];
  const valid = parsed.flatMap((item) => {
    const result = cardItemSchema.safeParse(item);
    if (!result.success) return [];
    const normalized = normalizeCardItem(result.data);
    return normalized ? [normalized] : [];
  });
  const normalized = normalizeLearningIds(valid);
  return normalized.every((item) => item.id.length <= MAX_LEARNING_ID_CHARS)
    ? normalized
    : [];
}
