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

import { NoObjectGeneratedError } from "ai";

import {
  citationSourcesFor,
  generateCarded,
  generateStudyPack,
  generateStudyPackStep,
  generateSummary,
  generateTestMe,
  generateTextFromPrompt,
  getModelId,
  regroundStudyDocument,
  visionReadImages,
  visionReadPages,
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
import { hasMeaningfulText, joinPages, withSlideImageText } from "@/lib/source-markers";
import { citedPageCount, studyItemTarget } from "@/lib/ai-budgets";
import { allocateItems, balancedHalves, splitSections } from "@/lib/study-sections";
import * as grounding from "@/lib/grounding";

const root = path.resolve(__dirname, "..");

const VERIFY_PROMPT_HEAD = "You are checking whether sentences from a study document are supported";

function isVerifyPrompt(prompt: string | undefined): boolean {
  return typeof prompt === "string" && prompt.startsWith(VERIFY_PROMPT_HEAD);
}

function verifyCalls() {
  return generateText.mock.calls.filter((call) => isVerifyPrompt((call[0] as { prompt?: string }).prompt));
}

/** A study document citing pages 1..18 of S1, one cited bullet per page. */
const EIGHTEEN_PAGE_DOC = [
  "## Antimicrobials",
  "",
  ...Array.from({ length: 18 }, (_, i) => `- Fact ${i + 1}. [S1 p.${i + 1}]`),
].join("\n");

/** Four separate topics, with 18 distinct cited pages across the whole document. */
const SECTIONED_EIGHTEEN_PAGE_DOC = [
  { heading: "Foundations", pages: [1, 2, 3] },
  { heading: "Mechanisms", pages: [4, 5, 6, 7, 8, 9, 10] },
  { heading: "Applications", pages: [11, 12, 13, 14] },
  { heading: "Contraindications", pages: [15, 16, 17, 18] },
].map(({ heading, pages }) => [
  `## ${heading}`,
  "",
  ...pages.map((page) => `- The specific fact for page ${page} is supported. [S1 p.${page}]`),
].join("\n")).join("\n\n");

/** Test Me items as the SDK returns them after the wire schema transform. */
function quizObjects(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `q${i + 1}`,
    question: `Question ${i + 1}?`,
    choices: [`Alpha ${i + 1}`, `Beta ${i + 1}`],
    answer: `Alpha ${i + 1}`,
    explanation: `Alpha ${i + 1} is right. [S1 p.1]`,
  }));
}

/** Test Me items in the raw wire shape the model writes. */
function quizWire(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `q${i + 1}`,
    s1_question: `Question ${i + 1}?`,
    s2_choices: [`Alpha ${i + 1}`, `Beta ${i + 1}`],
    s3_explanation: `Alpha ${i + 1} is right. [S1 p.1]`,
    s4_answer: `Alpha ${i + 1}`,
  }));
}

function cardObjects(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i + 1}`,
    front: `Front ${i + 1}`,
    back: `Back ${i + 1} [S1 p.1]`,
  }));
}

function objectCall(index = 0) {
  return generateObject.mock.calls[index]![0] as { prompt: string; maxOutputTokens: number };
}

/** The mocked "ai" module's NoObjectGeneratedError takes only a message. */
const MockNoObjectGeneratedError = NoObjectGeneratedError as unknown as new (message: string) => Error & {
  text?: string;
  response?: { modelId?: string };
};

function malformedObject(items: unknown[]) {
  const err = new MockNoObjectGeneratedError("could not parse the response");
  err.text = `\`\`\`json\n${JSON.stringify(items)}\n\`\`\``;
  err.response = { modelId: "provider/model" };
  return err;
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

  it("reads a slide batch in one request with each image labelled by its page", async () => {
    generateText.mockResolvedValue({ text: "  <<<page 3>>>\nFigure  " });
    const first = new Uint8Array([0xff, 0xd8, 0xff, 1]);
    const second = new Uint8Array([0xff, 0xd8, 0xff, 2]);

    const text = await visionReadPages(
      [
        { page: 3, mime: "image/jpeg", bytes: first },
        { page: 7, mime: "image/jpeg", bytes: second },
      ],
      "Read the slides",
    );

    expect(text).toBe("<<<page 3>>>\nFigure");
    expect(generateText).toHaveBeenCalledTimes(1);
    const call = generateText.mock.calls[0]![0] as {
      model: { modelId: string };
      maxOutputTokens: number;
      messages: Array<{ role: string; content: unknown[] }>;
    };
    expect(call.model.modelId).toBe(getModelId("vision"));
    expect(call.model.modelId).toMatch(/:free$/);
    expect(call.maxOutputTokens).toBe(MAX_VISION_OUTPUT_TOKENS);
    expect(call.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "Read the slides" },
        { type: "text", text: "Slide 3:" },
        { type: "image", image: first, mediaType: "image/jpeg" },
        { type: "text", text: "Slide 7:" },
        { type: "image", image: second, mediaType: "image/jpeg" },
      ],
    }]);
  });

  it("keeps single-image vision on the same request shape", async () => {
    generateText.mockResolvedValue({ text: "Notes" });
    const bytes = new Uint8Array([1, 2, 3]);
    await visionReadImages([{ mime: "image/png", bytes }], "Read the image");
    expect((generateText.mock.calls[0]![0] as { messages: unknown }).messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "Read the image" },
        { type: "image", image: bytes, mediaType: "image/png" },
      ],
    }]);
  });

  it("leaves marker-only sources out of a pack and keeps S-numbering stable", () => {
    const rows = [
      { id: "a", filename: "a.pdf", text: joinPages(["Penicillin binds PBPs."]) },
      { id: "scan", filename: "scan.pdf", text: joinPages(["", "", ""]) },
      { id: "empty", filename: "empty.pdf", text: joinPages([withSlideImageText("", "")]) },
      { id: "b", filename: "b.pdf", text: joinPages(["", withSlideImageText("", "Vancomycin structure")]) },
    ];
    const kept = rows.filter((row) => hasMeaningfulText(row.text))
      .map((row) => ({ sourceId: row.id, filename: row.filename, text: row.text }));
    expect(citationSourcesFor(kept).map((ref) => [ref.index, ref.sourceId])).toEqual([[1, "a"], [2, "b"]]);

    const route = readFileSync(
      path.join(root, "app/api/reviewers/[id]/generation/[jobId]/route.ts"),
      "utf8",
    );
    expect(route).toContain("hasMeaningfulText(row.text)");
    expect(route).not.toContain("row.text?.trim()");
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
    expect(pack.testMe).toEqual(JSON.parse(SAMPLE_TEST_ME_JSON).map((item: Record<string, unknown>) => ({
      ...item, id: expect.stringMatching(/^q-[0-9a-f]{8}$/),
    })));
    expect(pack.carded).toEqual(JSON.parse(SAMPLE_CARDED_JSON).map((item: Record<string, unknown>) => ({
      ...item, id: expect.stringMatching(/^c-[0-9a-f]{8}$/),
    })));
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
        front: `Front ${index}`,
        back: "Back",
      })),
      response: { modelId: "z-ai/glm-5.2:free" },
    });

    const cards = await generateCarded("# Summary\n\nMaterial");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards).toHaveLength(studyItemTarget("carded", "# Summary\n\nMaterial"));
    expect(cards[0]?.id).toMatch(/^c-[0-9a-f]{8}$/);
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  describe("page-scaled item targets", () => {
    it.each(["step", "standalone"] as const)("splits Test Me by sections and merges capped halves in order through %s", async (entryPoint) => {
      const lockedIn = SECTIONED_EIGHTEEN_PAGE_DOC;
      const halves = balancedHalves(lockedIn);
      const counts = allocateItems(18, halves);
      const objectPrompts: string[] = [];
      expect(splitSections(lockedIn).sections).toHaveLength(4);
      expect(citedPageCount(lockedIn)).toBe(18);
      expect(halves).toHaveLength(2);

      generateObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
        objectPrompts.push(prompt);
        const half = halves.findIndex((markdown, i) => prompt === testMePrompt(markdown, counts[i]));
        expect(half).toBeGreaterThanOrEqual(0);
        return {
          object: quizObjects(counts[half] + 5).map((item, i) => ({
            ...item,
            question: `Half ${half + 1} question ${i + 1}?`,
          })),
          response: { modelId: `provider/half-${half + 1}` },
        };
      });

      const result = entryPoint === "step"
        ? await generateStudyPackStep({ step: "test_me", lockedIn })
        : null;
      const items = result ? result.payload.content : await generateTestMe(lockedIn);
      expect(generateObject).toHaveBeenCalledTimes(2);
      expect(objectPrompts).toEqual(halves.map((half, i) => testMePrompt(half, counts[i])));
      for (const [i, prompt] of objectPrompts.entries()) {
        for (const { heading } of splitSections(lockedIn).sections) {
          if (halves[i].includes(`## ${heading}`)) expect(prompt).toContain(`## ${heading}`);
          else expect(prompt).not.toContain(`## ${heading}`);
        }
      }
      expect(items).toEqual(counts.flatMap((count, half) => Array.from({ length: count }, (_, i) => (
        expect.objectContaining({
          id: expect.stringMatching(/^q-[0-9a-f]{8}$/),
          question: `Half ${half + 1} question ${i + 1}?`,
        })
      ))));
      expect(items).toHaveLength(18);
      expect(new Set((items as Array<{ id: string }>).map((item) => item.id)).size).toBe(18);
      if (result) expect(result.modelUsed).toBe("provider/half-1");
      expect(generateText).not.toHaveBeenCalled();
    });

    it.each(["step", "standalone"] as const)("splits Carded from Summary and merges capped halves in order through %s", async (entryPoint) => {
      const summary = SECTIONED_EIGHTEEN_PAGE_DOC;
      const total = studyItemTarget("carded", summary);
      const halves = balancedHalves(summary);
      const counts = allocateItems(total, halves);
      const objectPrompts: string[] = [];
      expect(halves).toHaveLength(2);

      generateObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
        objectPrompts.push(prompt);
        const half = halves.findIndex((markdown, i) => prompt === cardedPrompt(markdown, counts[i]));
        expect(half).toBeGreaterThanOrEqual(0);
        return {
          object: cardObjects(counts[half] + 5).map((item, i) => ({
            ...item,
            front: `Half ${half + 1} card ${i + 1}`,
          })),
          response: { modelId: `provider/half-${half + 1}` },
        };
      });

      const result = entryPoint === "step"
        ? await generateStudyPackStep({ step: "carded", summary })
        : null;
      const items = result ? result.payload.content : await generateCarded(summary);
      expect(generateObject).toHaveBeenCalledTimes(2);
      expect(objectPrompts).toEqual(halves.map((half, i) => cardedPrompt(half, counts[i])));
      for (const [i, prompt] of objectPrompts.entries()) {
        for (const { heading } of splitSections(summary).sections) {
          if (halves[i].includes(`## ${heading}`)) expect(prompt).toContain(`## ${heading}`);
          else expect(prompt).not.toContain(`## ${heading}`);
        }
      }
      expect(items).toEqual(counts.flatMap((count, half) => Array.from({ length: count }, (_, i) => (
        expect.objectContaining({
          id: expect.stringMatching(/^c-[0-9a-f]{8}$/),
          front: `Half ${half + 1} card ${i + 1}`,
        })
      ))));
      expect(items).toHaveLength(total);
      expect(new Set((items as Array<{ id: string }>).map((item) => item.id)).size).toBe(total);
      if (result) expect(result.modelUsed).toBe("provider/half-1");
      expect(generateText).not.toHaveBeenCalled();
    });

    it("keeps the single-section Test Me prompt and call count unchanged", async () => {
      const total = studyItemTarget("test_me", EIGHTEEN_PAGE_DOC);
      generateObject.mockResolvedValue({ object: quizObjects(total), response: { modelId: "provider/model" } });

      const result = await generateStudyPackStep({ step: "test_me", lockedIn: EIGHTEEN_PAGE_DOC });

      expect(generateObject).toHaveBeenCalledTimes(1);
      expect(objectCall().prompt).toBe(testMePrompt(EIGHTEEN_PAGE_DOC, total));
      expect(result.payload.content).toHaveLength(total);
    });

    it.each(["test_me", "carded"] as const)("starts both %s halves before either completes and preserves input order", async (kind) => {
      const markdown = SECTIONED_EIGHTEEN_PAGE_DOC;
      const halves = balancedHalves(markdown);
      const counts = allocateItems(studyItemTarget(kind, markdown), halves);
      const promptFor = kind === "test_me" ? testMePrompt : cardedPrompt;
      const objects = (half: number) => kind === "test_me"
        ? quizObjects(counts[half]).map((item, i) => ({ ...item, question: `Half ${half + 1} item ${i + 1}` }))
        : cardObjects(counts[half]).map((item, i) => ({ ...item, front: `Half ${half + 1} item ${i + 1}` }));
      let finishFirst!: (result: { object: ReturnType<typeof objects>; response: { modelId: string } }) => void;
      const firstResult = new Promise<{ object: ReturnType<typeof objects>; response: { modelId: string } }>((resolve) => {
        finishFirst = resolve;
      });
      generateObject.mockImplementation(({ prompt }: { prompt: string }) => {
        if (prompt === promptFor(halves[0], counts[0])) return firstResult;
        expect(prompt).toBe(promptFor(halves[1], counts[1]));
        return Promise.resolve({ object: objects(1), response: { modelId: "provider/half-2" } });
      });

      const pending = generateStudyPackStep({ step: kind, lockedIn: markdown, summary: markdown });
      try {
        expect(generateObject).toHaveBeenCalledTimes(2);
      } finally {
        finishFirst({ object: objects(0), response: { modelId: "provider/half-1" } });
      }
      const result = await pending;
      const items = result.payload.content as Array<{ question?: string; front?: string }>;
      expect(items.map((item) => item.question ?? item.front)).toEqual([
        ...Array.from({ length: counts[0] }, (_, i) => `Half 1 item ${i + 1}`),
        ...Array.from({ length: counts[1] }, (_, i) => `Half 2 item ${i + 1}`),
      ]);
      expect(result.modelUsed).toBe("provider/half-1");
    });

    it.each([
      ["test_me", "step"], ["test_me", "standalone"],
      ["carded", "step"], ["carded", "standalone"],
    ] as const)("keeps %s content ids stable across citation changes and drops duplicate prompts through %s", async (kind, entryPoint) => {
      const markdown = SECTIONED_EIGHTEEN_PAGE_DOC;
      const halves = balancedHalves(markdown);
      const counts = allocateItems(studyItemTarget(kind, markdown), halves);
      const promptFor = kind === "test_me" ? testMePrompt : cardedPrompt;
      let round = 0;
      const texts = [
        [["Shared fact? [S1 p.1]", "Alpha fact?"], ["Shared fact? [S1 p.2]", "Beta fact?"]],
        [["Beta fact? [S2 p.8]"], ["Shared fact? [S2 p.9]", "New fact?"]],
      ];
      generateObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
        const half = halves.findIndex((value, i) => prompt === promptFor(value, counts[i]));
        expect(half).toBeGreaterThanOrEqual(0);
        return {
          object: texts[round][half].map((text, i) => kind === "test_me"
            ? { ...quizObjects(1)[0], id: `provider-${round}-${half}-${i}`, question: text }
            : { ...cardObjects(1)[0], id: `provider-${round}-${half}-${i}`, front: text }),
          response: { modelId: `provider/half-${half + 1}` },
        };
      });
      const run = async () => {
        if (entryPoint === "step") {
          return (await generateStudyPackStep({ step: kind, lockedIn: markdown, summary: markdown })).payload.content;
        }
        return kind === "test_me" ? generateTestMe(markdown) : generateCarded(markdown);
      };
      const first = await run() as Array<{ id: string; question?: string; front?: string }>;
      round = 1;
      const second = await run() as typeof first;

      expect(first.map((item) => item.question ?? item.front)).toEqual([
        "Shared fact? [S1 p.1]", "Alpha fact?", "Beta fact?",
      ]);
      expect(first).toHaveLength(3);
      expect(second).toHaveLength(3);
      const pattern = kind === "test_me" ? /^q-[0-9a-f]{8}$/ : /^c-[0-9a-f]{8}$/;
      for (const item of [...first, ...second]) expect(item.id).toMatch(pattern);
      expect(new Set(first.map((item) => item.id)).size).toBe(3);
      expect(new Set(second.map((item) => item.id)).size).toBe(3);
      expect(second[0].id).toBe(first[2].id);
      expect(second[1].id).toBe(first[0].id);
      expect(first.map((item) => item.id)).not.toContain(second[2].id);
      expect(generateObject).toHaveBeenCalledTimes(4);
    });

    it.each(["test_me", "carded"] as const)("rejects the entire %s step when the second half exhausts its retries", async (kind) => {
      const markdown = SECTIONED_EIGHTEEN_PAGE_DOC;
      const halves = balancedHalves(markdown);
      const counts = allocateItems(studyItemTarget(kind, markdown), halves);
      const promptFor = kind === "test_me" ? testMePrompt : cardedPrompt;
      const firstPrompt = promptFor(halves[0], counts[0]);
      const secondPrompt = promptFor(halves[1], counts[1]);
      const objectPrompts: string[] = [];
      generateObject.mockImplementation(async ({ prompt }: { prompt: string }) => {
        objectPrompts.push(prompt);
        if (prompt === secondPrompt) throw { statusCode: 503, message: "unavailable" };
        expect(prompt).toBe(firstPrompt);
        return {
          object: kind === "test_me" ? quizObjects(counts[0]) : cardObjects(counts[0]),
          response: { modelId: "provider/half-1" },
        };
      });

      await expect(generateStudyPackStep({ step: kind, lockedIn: markdown, summary: markdown }))
        .rejects.toMatchObject({ code: "unavailable", retryable: true });
      expect(objectPrompts.filter((prompt) => prompt === firstPrompt)).toHaveLength(1);
      expect(objectPrompts.filter((prompt) => prompt === secondPrompt)).toHaveLength(2);
      expect(generateObject).toHaveBeenCalledTimes(3);
      expect(generateText).not.toHaveBeenCalled();
    });

    it("keeps 18 Test Me items and 36 cards through the resumable step for an 18-page pack", async () => {
      generateObject.mockResolvedValueOnce({ object: quizObjects(50), response: { modelId: "provider/model" } });
      const testMe = await generateStudyPackStep({ step: "test_me", lockedIn: EIGHTEEN_PAGE_DOC });
      expect(testMe.payload.content).toHaveLength(18);
      expect(objectCall(0).prompt).toContain("Return about 18 items (never more than 18)");
      expect(objectCall(0).maxOutputTokens).toBe(18 * 350);

      generateObject.mockResolvedValueOnce({ object: cardObjects(50), response: { modelId: "provider/model" } });
      const carded = await generateStudyPackStep({ step: "carded", summary: EIGHTEEN_PAGE_DOC });
      expect(carded.payload.content).toHaveLength(36);
      expect(objectCall(1).prompt).toContain("Return about 36 cards (never more than 36)");
      expect(objectCall(1).maxOutputTokens).toBe(36 * 200);
      expect(generateObject).toHaveBeenCalledTimes(2);
    });

    it("keeps 18 Test Me items and 36 cards through generateTestMe and generateCarded", async () => {
      generateObject.mockResolvedValueOnce({ object: quizObjects(50), response: { modelId: "provider/model" } });
      expect(await generateTestMe(EIGHTEEN_PAGE_DOC)).toHaveLength(18);
      expect(objectCall(0).prompt).toContain("Return about 18 items");

      generateObject.mockResolvedValueOnce({ object: cardObjects(50), response: { modelId: "provider/model" } });
      expect(await generateCarded(EIGHTEEN_PAGE_DOC)).toHaveLength(36);
      expect(objectCall(1).prompt).toContain("Return about 36 cards");
    });

    it("caps local JSON recovery of a malformed object result at 18 and 36", async () => {
      generateObject.mockRejectedValueOnce(malformedObject(quizWire(50)));
      const testMe = await generateStudyPackStep({ step: "test_me", lockedIn: EIGHTEEN_PAGE_DOC });
      expect(testMe.payload.content).toHaveLength(18);
      expect(testMe.modelUsed).toBe("provider/model");

      generateObject.mockRejectedValueOnce(malformedObject(cardObjects(50)));
      expect(await generateCarded(EIGHTEEN_PAGE_DOC)).toHaveLength(36);

      generateObject.mockRejectedValueOnce(malformedObject(quizWire(50)));
      expect(await generateTestMe(EIGHTEEN_PAGE_DOC)).toHaveLength(18);
      expect(generateObject).toHaveBeenCalledTimes(3);
    });
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

  it("keeps the provider status visible through a wrapped generation error", async () => {
    const { parseProviderError, toGenerationError } = await import("@/lib/generation-errors");
    const wrapped = toGenerationError({ statusCode: 404, responseBody: { error: { message: "No endpoints found", code: 404 } } });
    expect(wrapped.code).toBe("unknown");
    expect(parseProviderError(wrapped).status).toBe(404);
  });

  it("does not report a failed database query as a model JSON failure", () => {
    const cause = Object.assign(new Error("cannot cast type generation_job_step to view_kind"), { name: "NeonDbError" });
    const queryError = new Error("Failed query: WITH input AS (SELECT * FROM jsonb_to_recordset($1::jsonb))", { cause });
    expect(classifyGenerationError(queryError)).toMatchObject({ code: "unknown", retryable: false });
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
    expect(testMePrompt("Body [S1 p.1]")).toContain("\"The text states\"");
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
      .mockRejectedValueOnce({ statusCode: 503, message: "unavailable" })
      .mockRejectedValueOnce({ statusCode: 503, message: "unavailable" });

    const result = await generateStudyPackStep({
      step: "locked_in",
      extractedTexts: [{ sourceId: "src-1", filename: "pharm.pdf", text: PHARM_SOURCE }],
    });

    // One retry, then the claim stays untagged and counted as unchecked.
    expect(verifyCalls()).toHaveLength(2);
    expect(result.modelUsed).toBe("provider/model");
    expect(result.payload.content).not.toContain(UNSOURCED_TOKEN);
    expect(result.meta?.grounding).toMatchObject({ verifierFailed: true, unsourced: 0, unchecked: 1 });
  });

  it("grounds Summary against the pack's sources and keeps the S<n> map", async () => {
    generateText
      .mockResolvedValueOnce({
        text: "- Metoprolol dramatically reverses pulmonary fibrosis within weeks of treatment. [S1 p.1]",
        response: { modelId: "provider/model" },
      })
      .mockResolvedValueOnce({ text: "not json" })
      .mockResolvedValueOnce({ text: "not json" });

    const citationSources = [{ index: 1, sourceId: "src-1", filename: "pharm.pdf", hasPages: true }];
    const result = await generateStudyPackStep({
      step: "summary",
      lockedIn: "# Locked In [S1 p.1]",
      citationSources,
      groundingSources: [{ index: 1, text: PHARM_SOURCE }],
    });

    expect(verifyCalls()).toHaveLength(2);
    const verifyPrompt = (verifyCalls()[0]?.[0] as { prompt: string }).prompt;
    expect(verifyPrompt).toContain("Beta blockers such as propranolol");
    expect(result.meta).toMatchObject({ citationSources, grounding: { verifierFailed: true } });
  });

  it("sanitizes Summary headings before grounding while preserving body citations", async () => {
    const body = "- Propranolol can cause bronchospasm in patients with asthma. [S1 p.2]";
    const table = [
      "| Drug | Adverse effects |",
      "| --- | --- |",
      "| Propranolol | Can cause bronchospasm in patients with asthma. |",
    ].join("\n");
    const text = `### Table 1.1: X [S1 p.1]\n\n${table}\n\n${body}`;
    generateText.mockResolvedValue({ text, response: { modelId: "provider/model" } });
    const citationSources = [{ index: 1, sourceId: "src-1", filename: "pharm.pdf", hasPages: true }];

    const result = await generateStudyPackStep({
      step: "summary",
      lockedIn: "## Drugs\n\nPropranolol causes bronchospasm. [S1 p.2]",
      citationSources,
      groundingSources: [{ index: 1, text: PHARM_SOURCE }],
    });

    expect(result.payload.content).toBe(`### Table: X\n\n${table}\n\n${body}`);
    // An unsanitized heading would restrict the uncited row to page 1,
    // but its support is on page 2. Cleanup must precede citation inheritance.
    expect(result.meta?.grounding).toMatchObject({ total: 2, cited: 1, lexicalSupported: 2, unsourced: 0 });
    expect(verifyCalls()).toHaveLength(0);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("sanitizes headings in standalone generateSummary and preserves body citations", async () => {
    const body = "- Propranolol causes bronchospasm. [S1 p.2]";
    generateText.mockResolvedValue({
      text: `### Table 1.1: X [S1 p.1]\n\n${body}`,
      response: { modelId: "provider/model" },
    });

    expect(await generateSummary("Locked In body")).toBe(`### Table: X\n\n${body}`);
    expect(generateText).toHaveBeenCalledTimes(1);
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
    expect(route).toContain("loadGroundingSources(job.reviewerId, citationSources)");
    const queries = readFileSync(path.join(root, "lib/queries.ts"), "utf8");
    expect(queries).toMatch(/eq\(sources\.reviewerId, reviewerId\), inArray\(sources\.id, ids\)/);
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

describe("grounding re-check report merging", () => {
  const markdown = "A saved claim with an unsourced marker. [[unsourced]]";
  const sources = [{ index: 1, text: "Source evidence." }];
  const previous: grounding.GroundingReport = {
    total: 100, cited: 90, lexicalSupported: 70, verifiedSupported: 20,
    unsourced: 5, unchecked: 5, uncheckedKeys: ["oldkey01", "oldkey02"],
    truncated: true, verifierFailed: true,
  };
  const pass: grounding.GroundingReport = {
    total: 101, cited: 91, lexicalSupported: 2, verifiedSupported: 1,
    unsourced: 3, unchecked: 1, uncheckedKeys: ["newkey01"],
    truncated: false, verifierFailed: false,
  };

  it("adds supported counts while replacing pending counts and keeping previous extra fields", async () => {
    const carried = { ...previous, savedField: "preserved" };
    const checkedMarkdown = "A saved claim with an unsourced marker.";
    const ground = vi.spyOn(grounding, "groundDocument").mockResolvedValue({ markdown: checkedMarkdown, report: pass });

    const result = await regroundStudyDocument(markdown, sources, { previous: carried });

    expect(ground).toHaveBeenCalledWith(expect.objectContaining({
      markdown, sources, recheck: { uncheckedKeys: previous.uncheckedKeys, legacyUnchecked: false },
    }));
    expect(result).toEqual({
      markdown: checkedMarkdown,
      report: { ...carried, ...pass, lexicalSupported: 72, verifiedSupported: 21 },
    });
  });

  it.each(["zero", "absent"] as const)("drops old pending counts and keys when the pass has %s pending claims", async (pending) => {
    const completed = { ...pass };
    delete completed.unchecked;
    delete completed.uncheckedKeys;
    const completedPass = pending === "zero" ? { ...completed, unchecked: 0, uncheckedKeys: [] } : completed;
    vi.spyOn(grounding, "groundDocument").mockResolvedValue({ markdown, report: completedPass });

    const result = await regroundStudyDocument(markdown, sources, { previous });

    expect(result.report).toEqual({ ...completed, lexicalSupported: 72, verifiedSupported: 21 });
    expect(result.report).not.toHaveProperty("unchecked");
    expect(result.report).not.toHaveProperty("uncheckedKeys");
  });

  it.each([
    ["no previous report", null, false],
    ["no unchecked count", { ...previous, unchecked: undefined, uncheckedKeys: undefined }, false],
    ["no recorded pending claims", { ...previous, unchecked: 0, uncheckedKeys: undefined }, false],
    ["legacy pending claims", { ...previous, uncheckedKeys: undefined }, true],
    ["recorded pending keys", previous, false],
    ["an explicitly empty key list", { ...previous, uncheckedKeys: [] as string[] }, false],
  ] as const)("enables legacyUnchecked only for unkeyed pending claims: %s", async (_name, prior, legacyUnchecked) => {
    const ground = vi.spyOn(grounding, "groundDocument").mockResolvedValue({ markdown, report: pass });

    const result = await regroundStudyDocument(markdown, sources, { previous: prior });

    expect(ground).toHaveBeenCalledWith(expect.objectContaining({
      recheck: { uncheckedKeys: prior?.uncheckedKeys, legacyUnchecked },
    }));
    expect(result.report?.lexicalSupported).toBe((prior?.lexicalSupported ?? 0) + pass.lexicalSupported);
    expect(result.report?.verifiedSupported).toBe((prior?.verifiedSupported ?? 0) + pass.verifiedSupported);
  });

  it("returns a null report when there are no sources, without carrying a stale report forward", async () => {
    const ground = vi.spyOn(grounding, "groundDocument");
    expect(await regroundStudyDocument(markdown, [], { previous })).toEqual({ markdown, report: null });
    expect(ground).not.toHaveBeenCalled();
  });
});
