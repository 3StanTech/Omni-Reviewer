import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SAMPLE_CARDED_JSON,
  SAMPLE_LOCKED_IN,
  SAMPLE_SUMMARY,
  SAMPLE_TEST_ME_JSON,
} from "./helpers";

vi.mock("server-only", () => ({}));

const generateText = vi.hoisted(() => vi.fn());
const generateObject = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateText(...args),
  generateObject: (...args: unknown[]) => generateObject(...args),
  NoObjectGeneratedError: class NoObjectGeneratedError extends Error {
    text?: string;
    response?: { modelId?: string };
    static isInstance(error: unknown): boolean {
      return (
        !!error &&
        typeof error === "object" &&
        (error as { name?: string }).name === "NoObjectGeneratedError"
      );
    }
    constructor(message?: string) {
      super(message);
      this.name = "NoObjectGeneratedError";
    }
  },
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => {
    return (modelId: string) => ({ modelId });
  },
}));

import {
  generateCarded,
  generateStudyPack,
  generateStudyPackStep,
  generateTextFromPrompt,
  visionReadImages,
} from "@/lib/ai";
import {
  MAX_VISION_OUTPUT_TOKENS,
  MAX_VISION_TEXT_CHARS,
  GENERATION_STEP_DEADLINE_MS,
} from "@/lib/learning-limits";
import { classifyGenerationError } from "@/lib/generation-errors";
import { stripCitations, UNSOURCED_TOKEN } from "@/lib/citations";
import {
  CITE_EVERY_CLAIM,
  NO_META_TEXT,
  PHARMACY_GUIDANCE,
  cardedPrompt,
  groundingVerifyPrompt,
  lockedInPrompt,
  summaryPrompt,
  testMePrompt,
} from "@/lib/prompts";
import { joinPages } from "@/lib/source-markers";

const root = path.resolve(__dirname, "..");

const VERIFY_PROMPT_HEAD = "You are checking whether sentences from a study document are supported";

function isVerifyPrompt(prompt: string | undefined): boolean {
  return typeof prompt === "string" && prompt.startsWith(VERIFY_PROMPT_HEAD);
}

function verifyCalls() {
  return generateText.mock.calls.filter((call) => isVerifyPrompt((call[0] as { prompt?: string }).prompt));
}

const PHARM_SOURCE = joinPages([
  "Beta blockers such as propranolol block beta adrenergic receptors and lower heart rate.",
  "Propranolol can cause bronchospasm in patients with asthma and should be avoided in asthma.",
]);

describe("generate", () => {
  beforeEach(() => {
    generateText.mockReset();
    generateObject.mockReset();
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
  });

  it("caps vision output tokens and rejects oversized vision text", async () => {
    generateText.mockResolvedValue({
      text: "x".repeat(MAX_VISION_TEXT_CHARS + 1),
    });

    await expect(visionReadImages(
      [{ mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
      "Read the image",
    )).rejects.toThrow(/vision output exceeds/i);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: MAX_VISION_OUTPUT_TOKENS,
    });
  });

  it("calls pipeline in order Locked In → Summary → Test Me → Carded", async () => {
    const rawMarker = "RAW_SOURCE_UNIQUE_TOKEN_xyz";
    const extractedTexts = [
      { filename: "notes.txt", text: `Intro lecture. ${rawMarker}` },
    ];

    const documentTexts = [SAMPLE_LOCKED_IN, SAMPLE_SUMMARY];
    generateText.mockImplementation(({ prompt }: { prompt: string }) => {
      if (isVerifyPrompt(prompt)) {
        return Promise.resolve({ text: "[]" });
      }
      return Promise.resolve({
        text: documentTexts.shift(),
        response: { modelId: "z-ai/glm-5.2:free" },
      });
    });

    generateObject
      .mockResolvedValueOnce({
        object: JSON.parse(SAMPLE_TEST_ME_JSON),
        response: { modelId: "z-ai/glm-5.2:free" },
      })
      .mockResolvedValueOnce({
        object: JSON.parse(SAMPLE_CARDED_JSON),
        response: { modelId: "z-ai/glm-5.2:free" },
      });

    expect(typeof generateTextFromPrompt).toBe("function");

    const pack = await generateStudyPack({ extractedTexts });

    const documentCalls = generateText.mock.calls.filter(
      (call) => !isVerifyPrompt((call[0] as { prompt: string }).prompt),
    );
    expect(documentCalls).toHaveLength(2);
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls.every((call) => (call[0] as { maxRetries: number }).maxRetries === 0)).toBe(true);
    expect(generateObject.mock.calls.every((call) => (call[0] as { maxRetries: number }).maxRetries === 0)).toBe(true);

    const textPrompts = documentCalls.map(
      (call) => (call[0] as { prompt: string }).prompt,
    );
    const objectPrompts = generateObject.mock.calls.map(
      (call) => (call[0] as { prompt: string }).prompt,
    );

    expect(textPrompts[0]).toBe(lockedInPrompt(extractedTexts));
    expect(textPrompts[1]).toBe(summaryPrompt(pack.lockedIn));
    expect(objectPrompts[0]).toBe(testMePrompt(pack.lockedIn));
    expect(objectPrompts[1]).toBe(cardedPrompt(pack.summary));

    // Summary is fed Locked In, not the raw sources.
    expect(textPrompts[1]).not.toContain(rawMarker);
    expect(textPrompts[1]).toContain(pack.lockedIn);

    // Test Me also derives from Locked In only.
    expect(objectPrompts[0]).not.toContain(rawMarker);
    expect(objectPrompts[0]).toContain(pack.lockedIn);

    // Carded derives from Summary only.
    expect(objectPrompts[1]).not.toContain(rawMarker);
    expect(objectPrompts[1]).toContain(pack.summary);
    expect(objectPrompts[1]).not.toBe(cardedPrompt(pack.lockedIn));

    // Call order: Locked In, Summary, Test Me, Carded.
    const [lockedInOrder, summaryOrder] = generateText.mock.calls
      .map((call, i) => ({ call, order: generateText.mock.invocationCallOrder[i] }))
      .filter(({ call }) => !isVerifyPrompt((call[0] as { prompt: string }).prompt))
      .map(({ order }) => order);
    const objectOrder = generateObject.mock.invocationCallOrder;
    expect(lockedInOrder).toBeLessThan(summaryOrder);
    expect(summaryOrder).toBeLessThan(objectOrder[0]);
    expect(objectOrder[0]).toBeLessThan(objectOrder[1]);

    // Only grounding markers may be added to the generated documents.
    expect(stripCitations(pack.lockedIn)).toBe(SAMPLE_LOCKED_IN);
    expect(stripCitations(pack.summary)).toBe(SAMPLE_SUMMARY);
    expect(pack.testMe).toEqual(JSON.parse(SAMPLE_TEST_ME_JSON));
    expect(pack.carded).toEqual(JSON.parse(SAMPLE_CARDED_JSON));
    expect(pack.meta.lockedIn.citationSources).toEqual([
      { index: 1, sourceId: "", filename: "notes.txt", hasPages: false },
    ]);
  });

  it("rejects an empty structured Carded result before it can be persisted", async () => {
    generateObject.mockResolvedValue({
      object: [],
      response: { modelId: "z-ai/glm-5.2:free" },
    });

    await expect(generateCarded("# Summary\n\nMaterial")).rejects.toThrow(/carded/i);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("keeps only the allowed number of items when the model overshoots the cap", async () => {
    generateObject.mockResolvedValue({
      object: Array.from({ length: 101 }, (_, index) => ({
        id: `c${index}`,
        front: "Front",
        back: "Back",
      })),
      response: { modelId: "z-ai/glm-5.2:free" },
    });

    const cards = await generateCarded("# Summary\n\nMaterial");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(100);
    expect(cards[0]?.id).toBe("c0");
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("generates one resumable step and preserves the provider model id", async () => {
    generateText.mockResolvedValueOnce({
      text: SAMPLE_LOCKED_IN,
      response: { modelId: "provider/actual-model" },
    });

    const result = await generateStudyPackStep({
      step: "locked_in",
      extractedTexts: [{
        filename: "notes.txt",
        text: "Photosynthesis converts light into chemical energy.",
      }],
    });

    expect(result).toMatchObject({
      step: "locked_in",
      payload: { kind: "locked_in", content: SAMPLE_LOCKED_IN },
      modelUsed: "provider/actual-model",
      meta: {
        citationSources: [{ index: 1, sourceId: "", filename: "notes.txt", hasPages: false }],
        grounding: { verifierFailed: false, unsourced: 0 },
      },
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("limits a retryable provider failure to two total SDK calls", async () => {
    generateText
      .mockRejectedValueOnce({ statusCode: 503, message: "unavailable" })
      .mockResolvedValueOnce({
        text: SAMPLE_LOCKED_IN,
        response: { modelId: "provider/actual-model" },
      });

    await expect(generateTextFromPrompt("short source", { purpose: "locked_in" })).resolves.toMatchObject({
      text: SAMPLE_LOCKED_IN,
    });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls.every((call) => (call[0] as { maxRetries: number }).maxRetries === 0)).toBe(true);
  });

  it("classifies the generation deadline abort as a timeout", async () => {
    vi.useFakeTimers();
    try {
      generateText.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => (
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        })
      ));

      const pending = generateTextFromPrompt("short source", { purpose: "locked_in" });
      const settled = pending.then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(GENERATION_STEP_DEADLINE_MS);

      await expect(settled).resolves.toMatchObject({ code: "timeout", retryable: true });
      expect(generateText).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps retryable generation errors", () => {
    expect(
      classifyGenerationError({ statusCode: 429, message: "rate limit" }),
    ).toMatchObject({ code: "rate_limited", retryable: true });

    expect(
      classifyGenerationError({ statusCode: 503, message: "unavailable" }),
    ).toMatchObject({ code: "unavailable", retryable: true });

    expect(
      classifyGenerationError({
        statusCode: 402,
        message: "Payment Required",
      }),
    ).toMatchObject({ code: "payment_required", retryable: false });

    expect(
      classifyGenerationError({
        statusCode: 400,
        message: "maximum context length exceeded",
      }),
    ).toMatchObject({ code: "token_limit", retryable: false });

    expect(
      classifyGenerationError(new SyntaxError("Unexpected token")),
    ).toMatchObject({ code: "json_parse", retryable: true });

    expect(
      classifyGenerationError(new Error("request timed out")),
    ).toMatchObject({ code: "timeout", retryable: true });

    expect(classifyGenerationError(new Error("provider secret details"))).toEqual(
      expect.objectContaining({
        code: "unknown",
        message: "Generation failed unexpectedly. Try again shortly.",
        retryable: false,
      }),
    );
  });

  it.each([
    ["HTTP 500", { statusCode: 500, message: "internal server error" }, "unavailable"],
    ["HTTP 504", { statusCode: 504, message: "gateway timeout" }, "unavailable"],
    ["fetch failed", new TypeError("fetch failed"), "unavailable"],
    ["connection reset", Object.assign(new Error("socket closed"), { code: "ECONNRESET" }), "unavailable"],
    ["connection refused", Object.assign(new Error("socket closed"), { code: "ECONNREFUSED" }), "unavailable"],
    ["network unreachable", Object.assign(new Error("network error"), { code: "ENETUNREACH" }), "unavailable"],
    ["DNS retry", Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" }), "unavailable"],
    ["network timeout", Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" }), "timeout"],
  ])("classifies %s as a redacted retryable failure", (_name, error, code) => {
    const classified = classifyGenerationError(error);

    expect(classified).toMatchObject({ code, retryable: true });
    expect(classified.message).toBe(
      code === "timeout"
        ? "Generation timed out. Try again in a moment."
        : "The model provider is temporarily unavailable. Try again shortly.",
    );
    expect(classified.message).not.toContain("socket");
    expect(classified.message).not.toContain("ECONN");
  });

  it("does not retry arbitrary unknown errors", () => {
    expect(classifyGenerationError(new Error("programming failure"))).toEqual({
      code: "unknown",
      message: "Generation failed unexpectedly. Try again shortly.",
      retryable: false,
    });
  });

  it("GET views route does not import generate at module scope", () => {
    const viewsRoute = readFileSync(
      path.join(root, "app/api/reviewers/[id]/views/route.ts"),
      "utf8",
    );

    expect(viewsRoute).not.toMatch(
      /import\s+.*generateStudyPack|from\s+["']@\/lib\/ai["']/,
    );
    expect(viewsRoute).not.toMatch(/generateTextFromPrompt|generateStudyPack/);
    expect(viewsRoute).toMatch(/export async function GET/);
  });

  it("GET generation job route does not import generate at module scope", () => {
    const jobRoute = readFileSync(
      path.join(root, "app/api/reviewers/[id]/generation/[jobId]/route.ts"),
      "utf8",
    );

    expect(jobRoute).not.toMatch(
      /import\s+.*generateStudyPack|from\s+["']@\/lib\/ai["']/,
    );
    expect(jobRoute).not.toMatch(/generateTextFromPrompt|generateStudyPack/);
    expect(jobRoute).toMatch(/export async function GET/);
  });
});

describe("grounded generation", () => {
  beforeEach(() => {
    generateText.mockReset();
    generateObject.mockReset();
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
  });

  it("requests citations and pharmacy tables and labels sources S1..Sn in the given order", () => {
    const prompt = lockedInPrompt([
      { filename: "b-pharm.pdf", text: PHARM_SOURCE },
      { filename: "a-notes.docx", text: "Plain notes without pages." },
    ]);
    expect(prompt).toContain(CITE_EVERY_CLAIM);
    expect(prompt).toContain(PHARMACY_GUIDANCE);
    expect(prompt).toContain(NO_META_TEXT);
    expect(summaryPrompt("# Locked In [S1 p.1]")).toContain(NO_META_TEXT);
    expect(prompt).toContain("### Source S1: b-pharm.pdf (pages 1-2)");
    expect(prompt).toContain("### Source S2: a-notes.docx\n");
    expect(prompt.indexOf("Source S1: b-pharm.pdf")).toBeLessThan(prompt.indexOf("Source S2: a-notes.docx"));
    expect(prompt).toContain("<<<page N>>> marks the start of page or slide N");
    expect(prompt).toContain("Bracket citations such as [S1 p.14] are allowed");
    expect(prompt).not.toContain("Do not invent citations");

    expect(summaryPrompt("Body [S1 p.1]")).toMatch(/Keep Locked In's citations verbatim/);
    expect(testMePrompt("Body [S1 p.1]")).toContain("Never write \"The document states\"");
    expect(testMePrompt("Body [S1 p.1]")).toMatch(/When the material is clinical[^\n]*case vignettes/);
    expect(testMePrompt("Body [S1 p.1]")).toMatch(/End every s3_explanation with the exact citation/);
    expect(testMePrompt("Body [S1 p.1]")).toMatch(/"s1_question"[\s\S]*"s2_choices"[\s\S]*"s3_explanation"[\s\S]*"s4_answer"/);
    expect(cardedPrompt("Body [S1 p.1]")).toMatch(/Prefer cloze \{\{\.\.\.\}\} cards/);
    expect(cardedPrompt("Body [S1 p.1]")).toMatch(/End every back with the exact citation/);

    const verify = groundingVerifyPrompt([{ id: 3, sentence: "A claim.", evidence: "Page text." }]);
    expect(verify).toContain("ONLY against the evidence text");
    expect(verify).toContain('[{"id":3,"sentence":"A claim.","evidence":"Page text."}]');
    expect(verify).toContain('"missing"');
  });

  it("does not call the verifier when every claim passes lexically", async () => {
    generateText.mockResolvedValueOnce({
      text: "Propranolol can cause bronchospasm in patients with asthma. [S1 p.2]",
      response: { modelId: "provider/model" },
    });

    const result = await generateStudyPackStep({
      step: "locked_in",
      extractedTexts: [{ sourceId: "src-1", filename: "pharm.pdf", text: PHARM_SOURCE }],
    });

    expect(verifyCalls()).toHaveLength(0);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.payload.content).not.toContain(UNSOURCED_TOKEN);
    expect(result.meta).toEqual({
      citationSources: [{ index: 1, sourceId: "src-1", filename: "pharm.pdf", hasPages: true }],
      grounding: expect.objectContaining({ total: 1, cited: 1, lexicalSupported: 1, unsourced: 0, verifierFailed: false }),
    });
  });

  it("verifies lexical misses in one call and tags unsupported sentences", async () => {
    generateText
      .mockResolvedValueOnce({
        text: [
          "Metoprolol dramatically reverses pulmonary fibrosis within weeks of starting treatment. [S1 p.1]",
          "",
          "Warfarin requires regular monitoring of clotting times for every single patient. [S1 p.2]",
        ].join("\n"),
        response: { modelId: "provider/model" },
      })
      .mockResolvedValueOnce({ text: '[{"id": 0, "supported": false}, {"id": 1, "supported": true}]' });

    const result = await generateStudyPackStep({
      step: "locked_in",
      extractedTexts: [{ sourceId: "src-1", filename: "pharm.pdf", text: PHARM_SOURCE }],
    });

    expect(verifyCalls()).toHaveLength(1);
    const content = result.payload.content as string;
    expect(content.split("\n")[0]).toContain(UNSOURCED_TOKEN);
    expect(content.split("\n")[2]).not.toContain(UNSOURCED_TOKEN);
    expect(result.meta?.grounding).toMatchObject({ verifiedSupported: 1, unsourced: 1, verifierFailed: false });
  });

  it("keeps the step successful when the verifier fails", async () => {
    generateText
      .mockResolvedValueOnce({
        text: "Metoprolol dramatically reverses pulmonary fibrosis within weeks of starting treatment. [S1 p.1]",
        response: { modelId: "provider/model" },
      })
      .mockRejectedValueOnce({ statusCode: 503, message: "unavailable" });

    const result = await generateStudyPackStep({
      step: "locked_in",
      extractedTexts: [{ sourceId: "src-1", filename: "pharm.pdf", text: PHARM_SOURCE }],
    });

    // One verify attempt only, even for a retryable provider error.
    expect(verifyCalls()).toHaveLength(1);
    expect(result.modelUsed).toBe("provider/model");
    expect(result.payload.content).toContain(UNSOURCED_TOKEN);
    expect(result.meta?.grounding).toMatchObject({ verifierFailed: true, unsourced: 1 });
  });

  it("grounds Summary against the pack's sources and keeps the S<n> map", async () => {
    generateText
      .mockResolvedValueOnce({
        text: "- Metoprolol dramatically reverses pulmonary fibrosis within weeks of treatment. [S1 p.1]",
        response: { modelId: "provider/model" },
      })
      .mockResolvedValueOnce({ text: "not json" });

    const citationSources = [{ index: 1, sourceId: "src-1", filename: "pharm.pdf", hasPages: true }];
    const result = await generateStudyPackStep({
      step: "summary",
      lockedIn: "# Locked In [S1 p.1]",
      citationSources,
      groundingSources: [{ index: 1, text: PHARM_SOURCE }],
    });

    expect(verifyCalls()).toHaveLength(1);
    const verifyPrompt = (verifyCalls()[0]?.[0] as { prompt: string }).prompt;
    expect(verifyPrompt).toContain("Beta blockers such as propranolol");
    expect(result.meta).toMatchObject({ citationSources, grounding: { verifierFailed: true } });
  });

  it("drops citations to unknown sources from Test Me explanations and Carded backs", async () => {
    generateObject.mockResolvedValueOnce({
      object: [{
        id: "q1",
        question: "Which drug causes bronchospasm?",
        choices: ["Propranolol", "Amlodipine"],
        answer: "Propranolol",
        explanation: "Beta blockade in asthma. [S1 p.2] [S7 p.3]",
      }],
      response: { modelId: "provider/model" },
    });
    const testMe = await generateStudyPackStep({
      step: "test_me",
      lockedIn: "# Locked In [S1 p.2]",
      citationSources: [{ index: 1, sourceId: "src-1", filename: "pharm.pdf", hasPages: true }],
    });
    expect((testMe.payload.content as Array<{ explanation: string }>)[0]?.explanation)
      .toBe("Beta blockade in asthma. [S1 p.2]");
    expect(testMe.meta).toBeUndefined();

    generateObject.mockResolvedValueOnce({
      object: [{ id: "c1", front: "Propranolol triad", back: "Bronchospasm [S3 p.1]" }],
      response: { modelId: "provider/model" },
    });
    const carded = await generateStudyPackStep({
      step: "carded",
      summary: "# Summary [S1 p.2]",
      citationSources: [{ index: 1, sourceId: "src-1", filename: "pharm.pdf", hasPages: true }],
    });
    expect((carded.payload.content as Array<{ back: string }>)[0]?.back).toBe("Bronchospasm");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("persists study-document meta for Locked In and Summary in a stable source order", () => {
    const route = readFileSync(
      path.join(root, "app/api/reviewers/[id]/generation/[jobId]/route.ts"),
      "utf8",
    );
    expect(route).toMatch(/\.orderBy\(asc\(sources\.createdAt\), asc\(sources\.id\)\)/);
    expect(route).toMatch(/generated\.meta \?\? \{ citationSources: \[\] \}/);
    expect(route).toContain("readStudyDocumentMeta(upstream.contentJson)");
    expect(route).toMatch(/eq\(sources\.reviewerId, reviewerId\), inArray\(sources\.id, ids\)/);
  });
});

describe("quiz answer repair", () => {
  it("maps a sentence answer onto the single choice it contains", async () => {
    const { repairQuizAnswer } = await import("@/lib/ai");
    expect(repairQuizAnswer({
      choices: ["Oxygen-dependent uptake", "Efflux pumps"],
      answer: "Because their oxygen-dependent uptake fails in anaerobes.",
    })).toMatchObject({ answer: "Oxygen-dependent uptake" });
  });

  it("maps a bare letter answer onto its choice", async () => {
    const { repairQuizAnswer } = await import("@/lib/ai");
    expect(repairQuizAnswer({ choices: ["Penicillin", "Vancomycin", "Linezolid"], answer: "B" }))
      .toMatchObject({ answer: "Vancomycin" });
  });

  it("drops ordered letter labels from choices and the answer", async () => {
    const { repairQuizAnswer } = await import("@/lib/ai");
    expect(repairQuizAnswer({
      choices: ["A. Antibiotics", "B. Chemotherapy", "C. Antimicrobials"],
      answer: "C. Antimicrobials",
    })).toMatchObject({ choices: ["Antibiotics", "Chemotherapy", "Antimicrobials"], answer: "Antimicrobials" });
    expect(repairQuizAnswer({
      choices: ["(A) Natural", "(B) Semi-synthetic", "(C) Synthetic"],
      answer: "(B)",
    })).toMatchObject({ choices: ["Natural", "Semi-synthetic", "Synthetic"], answer: "Semi-synthetic" });
  });

  it("keeps abbreviated names that only look like labels", async () => {
    const { repairQuizAnswer } = await import("@/lib/ai");
    const item = { choices: ["A. baumannii", "B. fragilis"], answer: "A. baumannii" };
    expect(repairQuizAnswer(item)).toBe(item);
  });

  it("flags an answer key that its own explanation contradicts", async () => {
    const { explanationContradictsAnswer } = await import("@/lib/ai");
    expect(explanationContradictsAnswer({
      choices: ["Class I reactions (Krebs Cycle)", "Class III reactions (macromolecule synthesis)", "Host DNA replication"],
      answer: "Class I reactions (Krebs Cycle)",
      explanation: "Class III reactions, such as protein and peptidoglycan synthesis, are targeted.",
    })).toBe(true);
    expect(explanationContradictsAnswer({
      choices: ["Class I reactions (Krebs Cycle)", "Class III reactions (macromolecule synthesis)", "Host DNA replication"],
      answer: "Class III reactions (macromolecule synthesis)",
      explanation: "Class III reactions, such as protein and peptidoglycan synthesis, are targeted.",
    })).toBe(false);
    expect(explanationContradictsAnswer({
      choices: ["Penicillin", "Vancomycin"],
      answer: "Vancomycin",
      explanation: "Glycopeptides bind D-Ala-D-Ala.",
    })).toBe(false);
  });

  it("leaves ambiguous answers for validation to reject", async () => {
    const { repairQuizAnswer } = await import("@/lib/ai");
    const item = { choices: ["30S", "50S"], answer: "Both 30S and 50S" };
    expect(repairQuizAnswer(item)).toBe(item);
  });
});
