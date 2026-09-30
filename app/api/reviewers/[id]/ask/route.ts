import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { answerFromPack, publicAskError } from "@/lib/ai";
import {
  ASK_HISTORY_MESSAGES,
  buildAskWhyQuestion,
  buildExplainQuestion,
  MAX_ASK_WHY_SENTENCE_CHARS,
  originKeyFor,
  type AskHistoryMessage,
  type AskQuestion,
} from "@/lib/ask";
import {
  MAX_ASK_QUESTION_CHARS,
  type AskOrigin,
  type AskRequest,
  type AskResponse,
  type ChatMessageDto,
} from "@/lib/ask-types";
import { MAX_LEARNING_ID_CHARS, MAX_TEST_ME_CHOICE_CHARS } from "@/lib/learning-limits";
import { logRedactedError } from "@/lib/public-errors";
import { getReviewer } from "@/lib/queries";
import { cappedBodyError, readCappedJson } from "@/lib/request-body";
import {
  clearThread,
  findReusableAnswer,
  insertExchange,
  listSavedAnswers,
  listThread,
  loadAskSources,
  loadExplainTarget,
  toChatMessageDto,
  type ChatExchange,
} from "@/lib/tutor-queries";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_ASK_BODY_BYTES = 64 * 1024;

const targetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("test_item"),
    itemId: z.string().trim().min(1).max(MAX_LEARNING_ID_CHARS),
    chosen: z.string().max(MAX_TEST_ME_CHOICE_CHARS),
  }).strict(),
  z.object({
    type: z.literal("card"),
    cardId: z.string().trim().min(1).max(100),
  }).strict(),
]);

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ask"),
    question: z.string().trim().min(1, "Type a question first.").max(
      MAX_ASK_QUESTION_CHARS,
      `Questions can be at most ${MAX_ASK_QUESTION_CHARS.toLocaleString()} characters.`,
    ),
  }).strict(),
  z.object({ kind: z.literal("explain"), target: targetSchema }).strict(),
  z.object({
    kind: z.literal("ask_why"),
    sentence: z.string().trim().min(1).max(
      MAX_ASK_WHY_SENTENCE_CHARS,
      `The sentence can be at most ${MAX_ASK_WHY_SENTENCE_CHARS.toLocaleString()} characters.`,
    ),
  }).strict(),
]);

type Context = { params: Promise<{ id: string }> };

function notFound() {
  return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
}

/** The signed-in user and their live pack, or the response to return instead. */
async function resolvePack(context: Context): Promise<
  { userId: string; reviewerId: string } | { response: NextResponse }
> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { id: reviewerId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer || reviewer.deletingAt) return { response: notFound() };
  return { userId, reviewerId };
}

function exchangeMessages(exchange: ChatExchange): ChatMessageDto[] {
  return [exchange.question, exchange.answer]
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .map(toChatMessageDto);
}

export async function GET(_request: Request, context: Context) {
  const pack = await resolvePack(context);
  if ("response" in pack) return pack.response;
  const [thread, saved] = await Promise.all([
    listThread(pack.reviewerId, pack.userId),
    listSavedAnswers(pack.reviewerId, pack.userId),
  ]);
  return NextResponse.json({
    messages: thread.map(toChatMessageDto),
    saved: saved.map((exchange) => ({
      answer: toChatMessageDto(exchange.answer),
      question: exchange.question ? toChatMessageDto(exchange.question) : null,
    })),
  });
}

export async function DELETE(_request: Request, context: Context) {
  const pack = await resolvePack(context);
  if ("response" in pack) return pack.response;
  await clearThread(pack.reviewerId, pack.userId);
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request, context: Context) {
  const pack = await resolvePack(context);
  if ("response" in pack) return pack.response;
  const { userId, reviewerId } = pack;

  let json: unknown;
  try {
    json = await readCappedJson(request, {
      maxBytes: MAX_ASK_BODY_BYTES,
      tooLargeMessage: "Ask request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const body: AskRequest = parsed.data;
  const originKey = originKeyFor(body);
  const origin: AskOrigin = body.kind === "ask" || !originKey
    ? { kind: "ask" }
    : { kind: body.kind, key: originKey };

  // A repeat Explain or Ask why returns the earlier answer with no model call.
  if (originKey) {
    const existing = await findReusableAnswer(reviewerId, userId, originKey);
    if (existing) {
      const response: AskResponse = { messages: exchangeMessages(existing), reused: true };
      return NextResponse.json(response);
    }
  }

  let question: AskQuestion;
  if (body.kind === "ask") {
    question = { prompt: body.question, displayText: body.question };
  } else if (body.kind === "ask_why") {
    question = buildAskWhyQuestion(body.sentence);
  } else {
    const target = await loadExplainTarget({
      reviewerId,
      userId,
      target: body.target.type === "test_item"
        ? { type: "test_item", itemId: body.target.itemId }
        : { type: "card", cardId: body.target.cardId },
    });
    if (!target) return NextResponse.json({ error: "That item was not found in this pack." }, { status: 404 });
    question = target.type === "test_item"
      ? buildExplainQuestion({
        question: target.item.question,
        choices: target.item.choices,
        answer: target.item.answer,
        explanation: target.item.explanation,
        chosen: body.target.type === "test_item" ? body.target.chosen : "",
      })
      : buildExplainQuestion({ front: target.card.front, back: target.card.back });
  }

  const sources = await loadAskSources(reviewerId, userId);
  if (sources.length === 0) {
    return NextResponse.json({ error: "Add a source with text first." }, { status: 409 });
  }

  // Plain questions carry the recent thread; Explain and Ask why are single-turn.
  let history: AskHistoryMessage[] = [];
  if (body.kind === "ask") {
    const thread = await listThread(reviewerId, userId, { limit: ASK_HISTORY_MESSAGES });
    history = thread.map((row) => ({ role: row.role, content: row.content }));
  }
  const previousUserTurn = [...history].reverse().find((message) => message.role === "user")?.content;
  const rankingText = previousUserTurn ? `${question.prompt}\n${previousUserTurn}` : question.prompt;

  let answer;
  try {
    answer = await answerFromPack({
      sources,
      history,
      question: question.prompt,
      rankingText,
      signal: request.signal,
    });
  } catch (error) {
    logRedactedError("Generation step failed", error, { userId, reviewerId });
    const { message, status } = publicAskError(error);
    return NextResponse.json({ error: message }, { status });
  }

  const stored = await insertExchange({
    reviewerId,
    userId,
    question: question.displayText,
    answer: answer.markdown,
    answerJson: {
      citationSources: answer.citationSources,
      refused: answer.refused,
      origin,
      pagesSent: answer.pagesSent,
    },
    modelId: answer.modelUsed,
    originKey,
  });
  if (!stored) return notFound();
  const response: AskResponse = {
    messages: [toChatMessageDto(stored.question), toChatMessageDto(stored.answer)],
    reused: false,
  };
  return NextResponse.json(response);
}
