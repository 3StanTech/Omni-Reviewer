import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const generateText = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateText(...args),
  generateObject: vi.fn(),
  NoObjectGeneratedError: class NoObjectGeneratedError extends Error {
    static isInstance(): boolean {
      return false;
    }
  },
}));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => (modelId: string) => ({ modelId }),
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queries", () => ({ getReviewer: vi.fn() }));
vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai");
  return { ...actual, answerFromPack: vi.fn() };
});
vi.mock("@/lib/tutor-queries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tutor-queries")>("@/lib/tutor-queries");
  return {
    ...actual,
    listThread: vi.fn(async () => []),
    listSavedAnswers: vi.fn(async () => []),
    findReusableAnswer: vi.fn(async () => null),
    insertExchange: vi.fn(),
    setSaved: vi.fn(),
    clearThread: vi.fn(async () => 0),
    createCardFromMessage: vi.fn(),
    loadAskSources: vi.fn(),
    loadExplainTarget: vi.fn(),
  };
});
vi.mock("@/lib/public-errors", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-errors")>("@/lib/public-errors");
  return { ...actual, logRedactedError: vi.fn() };
});

import { auth } from "@/auth";
import { answerFromPack } from "@/lib/ai";
import { MAX_ASK_WHY_SENTENCE_CHARS, originKeyFor, REFUSAL_MARKER } from "@/lib/ask";
import { MAX_ASK_QUESTION_CHARS } from "@/lib/ask-types";
import { UNSOURCED_TOKEN } from "@/lib/citations";
import { PublicError } from "@/lib/public-errors";
import { getReviewer } from "@/lib/queries";
import {
  clearThread,
  createCardFromMessage,
  findReusableAnswer,
  insertExchange,
  listSavedAnswers,
  listThread,
  loadAskSources,
  loadExplainTarget,
  setSaved,
  type ChatMessageRow,
} from "@/lib/tutor-queries";
import { DELETE, GET, POST } from "@/app/api/reviewers/[id]/ask/route";
import { PATCH } from "@/app/api/reviewers/[id]/ask/[messageId]/route";
import { POST as POST_CARD } from "@/app/api/reviewers/[id]/ask/[messageId]/card/route";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const REVIEWER_ID = "11111111-1111-4111-8111-111111111111";
const QUESTION_ID = "22222222-2222-4222-8222-222222222222";
const ANSWER_ID = "33333333-3333-4333-8333-333333333333";
const context = { params: Promise.resolve({ id: REVIEWER_ID }) };
const messageContext = { params: Promise.resolve({ id: REVIEWER_ID, messageId: ANSWER_ID }) };
const url = `https://omni-reviewer.example/api/reviewers/${REVIEWER_ID}/ask`;
const jsonRequest = (method: string, body: unknown) => new Request(url, {
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const citationSources = [{ index: 1, sourceId: "source-1", filename: "pharm.pdf", hasPages: true }];

function row(overrides: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: QUESTION_ID,
    userId: "user-1",
    reviewerId: REVIEWER_ID,
    role: "user",
    content: "What is a beta blocker?",
    contentJson: { origin: { kind: "ask" } },
    modelId: null,
    replyToId: null,
    originKey: null,
    savedAt: null,
    clearedAt: null,
    createdAt: new Date("2026-09-30T00:00:00Z"),
    ...overrides,
  };
}

const questionRow = row({});
const answerRow = row({
  id: ANSWER_ID,
  role: "assistant",
  content: "It blocks beta receptors [S1 p.2].",
  contentJson: { citationSources, refused: false, origin: { kind: "ask" }, pagesSent: "all" },
  modelId: "z-ai/glm-5.2:free",
  replyToId: QUESTION_ID,
});

const packAnswer = {
  markdown: "It blocks beta receptors [S1 p.2].",
  refused: false,
  citationSources,
  pagesSent: "all" as const,
  modelUsed: "z-ai/glm-5.2:free",
};

beforeEach(() => {
  mock(auth).mockResolvedValue({ user: { id: "user-1" } });
  mock(getReviewer).mockResolvedValue({ id: REVIEWER_ID, deletingAt: null });
  mock(listThread).mockResolvedValue([]);
  mock(listSavedAnswers).mockResolvedValue([]);
  mock(findReusableAnswer).mockResolvedValue(null);
  mock(clearThread).mockResolvedValue(0);
  mock(loadAskSources).mockResolvedValue([
    { sourceId: "source-1", filename: "pharm.pdf", text: "<<<page 2>>>\nBeta blockers block beta receptors." },
  ]);
  mock(answerFromPack).mockResolvedValue(packAnswer);
  mock(insertExchange).mockResolvedValue({ question: questionRow, answer: answerRow });
});

describe("GET and DELETE /api/reviewers/[id]/ask", () => {
  it("requires a session and an owned pack", async () => {
    mock(auth).mockResolvedValueOnce(null);
    expect((await GET(new Request(url), context)).status).toBe(401);
    mock(getReviewer).mockResolvedValueOnce(null);
    expect((await GET(new Request(url), context)).status).toBe(404);
    mock(getReviewer).mockResolvedValueOnce({ id: REVIEWER_ID, deletingAt: new Date() });
    expect((await DELETE(new Request(url, { method: "DELETE" }), context)).status).toBe(404);
    expect(mock(listThread)).not.toHaveBeenCalled();
    expect(mock(clearThread)).not.toHaveBeenCalled();
  });

  it("returns the thread and the saved answers with their questions", async () => {
    mock(listThread).mockResolvedValueOnce([questionRow, answerRow]);
    mock(listSavedAnswers).mockResolvedValueOnce([
      { question: questionRow, answer: { ...answerRow, savedAt: new Date() } },
      { question: null, answer: { ...answerRow, id: "saved-2", savedAt: new Date() } },
    ]);
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    expect(body.messages[1]).toMatchObject({ id: ANSWER_ID, citationSources, refused: false, saved: false });
    expect(body.saved).toHaveLength(2);
    expect(body.saved[0]).toMatchObject({ answer: { saved: true }, question: { id: QUESTION_ID } });
    expect(body.saved[1].question).toBeNull();
    expect(mock(listThread)).toHaveBeenCalledWith(REVIEWER_ID, "user-1");
  });

  it("clears the thread", async () => {
    const response = await DELETE(new Request(url, { method: "DELETE" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mock(clearThread)).toHaveBeenCalledWith(REVIEWER_ID, "user-1");
  });
});

describe("POST /api/reviewers/[id]/ask", () => {
  it("requires a session and an owned pack before reading the body", async () => {
    mock(auth).mockResolvedValueOnce(null);
    expect((await POST(jsonRequest("POST", { kind: "ask", question: "Why?" }), context)).status).toBe(401);
    mock(getReviewer).mockResolvedValueOnce(null);
    expect((await POST(jsonRequest("POST", { kind: "ask", question: "Why?" }), context)).status).toBe(404);
    expect(mock(answerFromPack)).not.toHaveBeenCalled();
  });

  it("validates kinds and length limits", async () => {
    const bad = [
      { kind: "ask", question: "x".repeat(MAX_ASK_QUESTION_CHARS + 1) },
      { kind: "ask", question: "   " },
      { kind: "ask_why", sentence: "y".repeat(MAX_ASK_WHY_SENTENCE_CHARS + 1) },
      { kind: "chat", question: "Hi" },
      { kind: "explain", target: { type: "view", id: "x" } },
      { kind: "ask", question: "Hi", extra: true },
    ];
    for (const body of bad) {
      const response = await POST(jsonRequest("POST", body), context);
      expect(response.status).toBe(400);
      expect(typeof (await response.json()).error).toBe("string");
    }
    expect(mock(answerFromPack)).not.toHaveBeenCalled();
    expect(mock(insertExchange)).not.toHaveBeenCalled();
  });

  it("answers a question with the recent thread and stores the exchange", async () => {
    mock(listThread).mockResolvedValueOnce([
      row({ content: "What do beta blockers do?" }),
      row({ id: ANSWER_ID, role: "assistant", content: "They slow the heart [S1 p.2]." }),
    ]);
    const response = await POST(jsonRequest("POST", { kind: "ask", question: "  And side effects?  " }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reused).toBe(false);
    expect(body.messages.map((message: { id: string }) => message.id)).toEqual([QUESTION_ID, ANSWER_ID]);

    expect(mock(listThread)).toHaveBeenCalledWith(REVIEWER_ID, "user-1", { limit: 6 });
    const call = mock(answerFromPack).mock.calls[0][0];
    expect(call.question).toBe("And side effects?");
    expect(call.history).toEqual([
      { role: "user", content: "What do beta blockers do?" },
      { role: "assistant", content: "They slow the heart [S1 p.2]." },
    ]);
    expect(call.rankingText).toContain("And side effects?");
    expect(call.rankingText).toContain("What do beta blockers do?");
    expect(mock(insertExchange)).toHaveBeenCalledWith({
      reviewerId: REVIEWER_ID,
      userId: "user-1",
      question: "And side effects?",
      answer: packAnswer.markdown,
      answerJson: { citationSources, refused: false, origin: { kind: "ask" }, pagesSent: "all" },
      modelId: "z-ai/glm-5.2:free",
      originKey: null,
    });
  });

  it("returns 409 when the pack has no source text", async () => {
    mock(loadAskSources).mockResolvedValueOnce([]);
    const response = await POST(jsonRequest("POST", { kind: "ask", question: "Why?" }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Add a source with text first." });
    expect(mock(answerFromPack)).not.toHaveBeenCalled();
  });

  it("reuses an earlier Explain answer with no model call", async () => {
    const explainOrigin = { kind: "explain", key: "test:q1" };
    const reusedQuestion = row({ content: "Explain: What is X?", contentJson: { origin: explainOrigin }, originKey: "test:q1" });
    const reusedAnswer = { ...answerRow, contentJson: { citationSources, refused: false, origin: explainOrigin }, originKey: "test:q1" };
    mock(findReusableAnswer).mockResolvedValueOnce({ question: reusedQuestion, answer: reusedAnswer });

    const response = await POST(jsonRequest("POST", {
      kind: "explain",
      target: { type: "test_item", itemId: "q1", chosen: "c".repeat(500) },
    }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reused).toBe(true);
    expect(body.messages.map((message: { id: string }) => message.id)).toEqual([QUESTION_ID, ANSWER_ID]);
    expect(body.messages[1].origin).toEqual(explainOrigin);
    expect(mock(findReusableAnswer)).toHaveBeenCalledWith(REVIEWER_ID, "user-1", "test:q1");
    expect(mock(answerFromPack)).not.toHaveBeenCalled();
    expect(mock(loadAskSources)).not.toHaveBeenCalled();
    expect(mock(insertExchange)).not.toHaveBeenCalled();
  });

  it("explains a quiz item single-turn with the short visible question", async () => {
    mock(loadExplainTarget).mockResolvedValueOnce({
      type: "test_item",
      item: { id: "q1", question: "Which drug blocks beta receptors?", choices: ["Propranolol", "Atropine"], answer: "Propranolol", explanation: "It is a beta blocker [S1 p.2]." },
      viewRevision: 3,
      citationSources,
    });
    const response = await POST(jsonRequest("POST", {
      kind: "explain",
      target: { type: "test_item", itemId: "q1", chosen: "Atropine" },
    }), context);
    expect(response.status).toBe(200);
    expect(mock(loadExplainTarget)).toHaveBeenCalledWith({
      reviewerId: REVIEWER_ID,
      userId: "user-1",
      target: { type: "test_item", itemId: "q1" },
    });
    expect(mock(listThread)).not.toHaveBeenCalled();
    const call = mock(answerFromPack).mock.calls[0][0];
    expect(call.history).toEqual([]);
    expect(call.question).toContain("I chose: Atropine (incorrect)");
    expect(mock(insertExchange)).toHaveBeenCalledWith(expect.objectContaining({
      question: "Explain: Which drug blocks beta receptors?",
      originKey: "test:q1",
      answerJson: expect.objectContaining({ origin: { kind: "explain", key: "test:q1" } }),
    }));
  });

  it("returns 404 for an unknown or foreign Explain target without a model call", async () => {
    mock(loadExplainTarget).mockResolvedValueOnce(null);
    const response = await POST(jsonRequest("POST", {
      kind: "explain",
      target: { type: "card", cardId: "44444444-4444-4444-8444-444444444444" },
    }), context);
    expect(response.status).toBe(404);
    expect(mock(answerFromPack)).not.toHaveBeenCalled();
    expect(mock(insertExchange)).not.toHaveBeenCalled();
  });

  it("asks why without history and keys the answer for reuse", async () => {
    const sentence = "Beta blockers cure asthma [S1 p.4].";
    const response = await POST(jsonRequest("POST", { kind: "ask_why", sentence }), context);
    expect(response.status).toBe(200);
    const key = originKeyFor({ kind: "ask_why", sentence });
    expect(mock(findReusableAnswer)).toHaveBeenCalledWith(REVIEWER_ID, "user-1", key);
    expect(mock(listThread)).not.toHaveBeenCalled();
    expect(mock(answerFromPack).mock.calls[0][0].history).toEqual([]);
    expect(mock(insertExchange)).toHaveBeenCalledWith(expect.objectContaining({
      question: "Ask why: Beta blockers cure asthma.",
      originKey: key,
    }));
  });

  it("stores nothing when the model fails", async () => {
    mock(answerFromPack).mockRejectedValueOnce(new Error("socket hang up"));
    const response = await POST(jsonRequest("POST", { kind: "ask", question: "Why?" }), context);
    expect(response.status).toBeGreaterThanOrEqual(500);
    const body = await response.json();
    expect(body.error).not.toContain("socket");
    expect(mock(insertExchange)).not.toHaveBeenCalled();
  });

  it("maps a provider 429 to the free limit wording", async () => {
    mock(answerFromPack).mockRejectedValueOnce(
      Object.assign(new Error("Rate limit exceeded: free-models-per-day"), { statusCode: 429 }),
    );
    const response = await POST(jsonRequest("POST", { kind: "ask", question: "Why?" }), context);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "The free model limit is used up for now. Try again later today.",
    });
    expect(mock(insertExchange)).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/reviewers/[id]/ask/[messageId]", () => {
  it("requires a session and an owned pack", async () => {
    mock(auth).mockResolvedValueOnce(null);
    expect((await PATCH(jsonRequest("PATCH", { saved: true }), messageContext)).status).toBe(401);
    mock(getReviewer).mockResolvedValueOnce(null);
    expect((await PATCH(jsonRequest("PATCH", { saved: true }), messageContext)).status).toBe(404);
    expect(mock(setSaved)).not.toHaveBeenCalled();
  });

  it("returns 404 for a foreign, missing or refused answer", async () => {
    mock(setSaved).mockResolvedValueOnce(null);
    const response = await PATCH(jsonRequest("PATCH", { saved: true }), messageContext);
    expect(response.status).toBe(404);
    expect(mock(setSaved)).toHaveBeenCalledWith(ANSWER_ID, REVIEWER_ID, "user-1", true);
  });

  it("validates the body and returns the updated message", async () => {
    expect((await PATCH(jsonRequest("PATCH", { saved: "yes" }), messageContext)).status).toBe(400);
    mock(setSaved).mockResolvedValueOnce({ ...answerRow, savedAt: new Date() });
    const response = await PATCH(jsonRequest("PATCH", { saved: true }), messageContext);
    expect(response.status).toBe(200);
    expect((await response.json()).message).toMatchObject({ id: ANSWER_ID, saved: true });
  });
});

describe("POST /api/reviewers/[id]/ask/[messageId]/card", () => {
  const card = { id: "card-1" };

  it("requires a session and an owned pack", async () => {
    mock(auth).mockResolvedValueOnce(null);
    expect((await POST_CARD(jsonRequest("POST", { front: "F", back: "B" }), messageContext)).status).toBe(401);
    mock(getReviewer).mockResolvedValueOnce(null);
    expect((await POST_CARD(jsonRequest("POST", { front: "F", back: "B" }), messageContext)).status).toBe(404);
    expect(mock(createCardFromMessage)).not.toHaveBeenCalled();
  });

  it("maps a new and a repeated card to created and cardId", async () => {
    mock(createCardFromMessage).mockResolvedValueOnce({ card, created: true });
    const first = await POST_CARD(jsonRequest("POST", { front: " What blocks beta receptors? ", back: "Propranolol [S1 p.2]" }), messageContext);
    expect(await first.json()).toEqual({ created: true, cardId: "card-1" });
    expect(mock(createCardFromMessage)).toHaveBeenCalledWith({
      messageId: ANSWER_ID,
      reviewerId: REVIEWER_ID,
      userId: "user-1",
      front: "What blocks beta receptors?",
      back: "Propranolol [S1 p.2]",
    });

    mock(createCardFromMessage).mockResolvedValueOnce({ card, created: false });
    const second = await POST_CARD(jsonRequest("POST", { front: "What blocks beta receptors?", back: "Propranolol" }), messageContext);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ created: false, cardId: "card-1" });
  });

  it("rejects invalid card text with 400 and unknown answers with 404", async () => {
    expect((await POST_CARD(jsonRequest("POST", { front: "", back: "B" }), messageContext)).status).toBe(400);
    expect((await POST_CARD(jsonRequest("POST", { front: "{{unbalanced", back: "B" }), messageContext)).status).toBe(400);
    mock(createCardFromMessage).mockRejectedValueOnce(new PublicError("Card front and back must be filled in and within the card limits."));
    const refused = await POST_CARD(jsonRequest("POST", { front: "F", back: "B" }), messageContext);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/card limits/);
    mock(createCardFromMessage).mockResolvedValueOnce(null);
    expect((await POST_CARD(jsonRequest("POST", { front: "F", back: "B" }), messageContext)).status).toBe(404);
  });
});

describe("answerFromPack", () => {
  let actualAnswerFromPack: typeof import("@/lib/ai").answerFromPack;

  beforeAll(async () => {
    process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdefgh";
    process.env.AUTH_TRUST_HOST = "true";
    process.env.DATABASE_URL = "postgresql://user:password@example.test/db";
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
    process.env.AUTH_URL = "http://localhost:3000";
    process.env.OPENROUTER_API_KEY = "test-key-not-real";
    process.env.AI_MODEL_LOCKED_IN = "z-ai/glm-5.2:free";
    process.env.AI_MODEL_SUMMARY = "z-ai/glm-5.2:free";
    process.env.AI_MODEL_JSON = "z-ai/glm-5.2:free";
    process.env.AI_MODEL_FALLBACKS =
      "nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,openrouter/free";
    actualAnswerFromPack = (await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai")).answerFromPack;
  });

  beforeEach(() => {
    generateText.mockReset();
  });

  const sources = [
    { sourceId: "source-1", filename: "pharm.pdf", text: "<<<page 1>>>\nPropranolol blocks beta receptors and slows the heart rate." },
  ];

  it("grounds with the text check only, in one request, and passes pagesSent through", async () => {
    generateText.mockResolvedValue({
      text: "Propranolol blocks beta receptors [S1 p.1]. The moon is made of cheese.",
      response: { modelId: "z-ai/glm-5.2:free" },
    });
    const result = await actualAnswerFromPack({ sources, history: [], question: "What does propranolol do?" });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 1_200 });
    expect(result.refused).toBe(false);
    expect(result.pagesSent).toBe("all");
    expect(result.modelUsed).toBe("z-ai/glm-5.2:free");
    expect(result.citationSources).toEqual([{ index: 1, sourceId: "source-1", filename: "pharm.pdf", hasPages: true }]);
    expect(result.markdown).toContain("Propranolol blocks beta receptors [S1 p.1].");
    expect(result.markdown).toContain(`The moon is made of cheese. ${UNSOURCED_TOKEN}`);
  });

  it("returns a refusal without grounding tags", async () => {
    generateText.mockResolvedValue({
      text: `${REFUSAL_MARKER}\nThe lecture covers beta blockers nearby.`,
    });
    const result = await actualAnswerFromPack({ sources, history: [], question: "Who won the World Cup?" });
    expect(result.refused).toBe(true);
    expect(result.markdown).toBe("The lecture covers beta blockers nearby.");
    expect(result.markdown).not.toContain(UNSOURCED_TOKEN);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("sends only the best pages when the sources exceed the budget", async () => {
    const filler = "Unrelated renal physiology filler text about nephrons. ".repeat(900);
    const pages = Array.from({ length: 12 }, (_, i) =>
      `<<<page ${i + 1}>>>\n${i === 6 ? "Propranolol blocks beta receptors. " : ""}${filler}`).join("\n");
    generateText.mockResolvedValue({ text: "Propranolol blocks beta receptors [S1 p.7]." });
    const result = await actualAnswerFromPack({
      sources: [{ sourceId: "source-1", filename: "big.pdf", text: pages }],
      history: [],
      question: "What does propranolol block?",
    });
    expect(result.pagesSent).not.toBe("all");
    expect((result.pagesSent as Record<number, number[]>)[1]).toContain(7);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
