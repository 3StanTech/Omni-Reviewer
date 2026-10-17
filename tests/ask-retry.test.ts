import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/free-request-ledger", () => ({ recordModelRequest: vi.fn(), markDailyLimitReached: vi.fn() }));

import { answerFromPack } from "@/lib/ai";

const SUPER_VL = "nvidia/nemotron-3.5-super-vl:free";
const DOTS = "dots-studio/dots-3-note-preview:free";

const fetchMock = vi.fn();

beforeAll(() => {
  process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdefgh";
  process.env.AUTH_TRUST_HOST = "true";
  process.env.DATABASE_URL = "postgresql://user:password@example.test/db";
  process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
  process.env.AUTH_URL = "http://localhost:3000";
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  // Production defaults: Ask on Super VL, then dots and Gemma.
  delete process.env.AI_MODEL_ASK;
  delete process.env.AI_MODEL_FALLBACKS;
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

it("sends Ask's first request to Super VL alone and lets only the retry fall back to dots", async () => {
  fetchMock
    .mockResolvedValueOnce(json(429, { error: { code: 429, message: "rate_limit: upstream is temporarily rate-limited" } }))
    .mockResolvedValueOnce(json(200, {
      id: "gen-1",
      object: "chat.completion",
      created: 1,
      model: DOTS,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Linezolid with tramadol raises the risk of serotonin syndrome [S1 p.18]." },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }));

  const answer = await answerFromPack({
    sources: [{ filename: "pha.pdf", text: "<<<page 18>>>\nLinezolid-Tramadol Increased risk of serotonin syndrome" }],
    history: [],
    question: "What adverse event can happen when linezolid is combined with tramadol?",
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [first, second] = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  expect(first.model).toBe(SUPER_VL);
  expect(first.models ?? []).toEqual([]);
  expect(second.model).toBe(SUPER_VL);
  expect(second.models).toContain(DOTS);
  expect(answer).toMatchObject({ refused: false, modelUsed: DOTS });
});
