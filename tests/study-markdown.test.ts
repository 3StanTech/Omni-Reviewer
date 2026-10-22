import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/free-request-ledger", () => ({ recordModelRequest: vi.fn(), markDailyLimitReached: vi.fn() }));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => (modelId: string) => ({ modelId }),
}));

import { generateStudyPackStep } from "@/lib/ai";
import { classifyGenerationError, GenerationError, publicGenerationErrorMessage } from "@/lib/generation-errors";
import {
  MAX_STUDY_MARKDOWN_CHARS,
  MAX_STUDY_MATH_BLOCKS,
  MAX_STUDY_MATH_CHARS,
  studyMarkdownProblem,
} from "@/lib/study-markdown";

const TOO_LONG = "This study content is too long to display (over 100,000 characters).";
const TOO_MUCH_MATH =
  "This study content has too much math to display safely (over 200 formulas or 12,000 characters of math).";

function formulas(count: number): string {
  return `# Algebra\n\n${Array.from({ length: count }, (_, i) => `Step $x_${i}$.`).join("\n")}`;
}

/** One display formula whose delimiters and body total `chars` characters. */
function displayMath(chars: number): string {
  return `# Proof\n\n$$${"x".repeat(chars - 4)}$$\n`;
}

describe("studyMarkdownProblem", () => {
  it("accepts content at exactly the character limit and refuses one more", () => {
    expect(studyMarkdownProblem("a".repeat(MAX_STUDY_MARKDOWN_CHARS))).toBeNull();
    expect(studyMarkdownProblem("a".repeat(MAX_STUDY_MARKDOWN_CHARS + 1))).toBe(TOO_LONG);
  });

  it("accepts exactly the formula limit and refuses one more", () => {
    expect(studyMarkdownProblem(formulas(MAX_STUDY_MATH_BLOCKS))).toBeNull();
    expect(studyMarkdownProblem(formulas(MAX_STUDY_MATH_BLOCKS + 1))).toBe(TOO_MUCH_MATH);
  });

  it("accepts exactly the math character limit and refuses one more", () => {
    expect(studyMarkdownProblem(displayMath(MAX_STUDY_MATH_CHARS))).toBeNull();
    expect(studyMarkdownProblem(displayMath(MAX_STUDY_MATH_CHARS + 1))).toBe(TOO_MUCH_MATH);
  });

  it("reports length first when content is both too long and too mathematical", () => {
    const content = formulas(MAX_STUDY_MATH_BLOCKS + 1) + "\n" + "a".repeat(MAX_STUDY_MARKDOWN_CHARS);
    expect(studyMarkdownProblem(content)).toBe(TOO_LONG);
  });

  it("does not count unmatched dollar signs as formulas", () => {
    expect(studyMarkdownProblem(`# Prices\n\n${"Costs $5 each.\n".repeat(MAX_STUDY_MATH_BLOCKS + 50)}`)).toBeNull();
  });
});

describe("generation refuses study documents the reader cannot display", () => {
  beforeEach(() => {
    generateText.mockReset();
    process.env.AUTH_SECRET = "test-auth-secret-0123456789abcdefgh";
    process.env.AUTH_TRUST_HOST = "true";
    process.env.DATABASE_URL = "postgresql://user:password@example.test/db";
    process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
    process.env.AUTH_URL = "http://localhost:3000";
    process.env.OPENROUTER_API_KEY = "test-key-not-real";
    process.env.AI_MODEL_LOCKED_IN = "z-ai/glm-5.2:free";
    process.env.AI_MODEL_SUMMARY = "z-ai/glm-5.2:free";
    process.env.AI_MODEL_JSON = "z-ai/glm-5.2:free";
  });

  it.each([
    ["over-long", `## Lecture\n\n${"Example study sentence. ".repeat(4400)}`, TOO_LONG],
    ["math-heavy", formulas(MAX_STUDY_MATH_BLOCKS + 1).replace("# Algebra", "## Algebra"), TOO_MUCH_MATH],
  ])("fails a %s Locked In step without retrying or returning it", async (_label, text, reason) => {
    generateText.mockResolvedValue({ text, finishReason: "stop", response: { modelId: "provider/model" } });
    const error = await generateStudyPackStep({
      step: "locked_in",
      extractedTexts: [{ filename: "notes.txt", text: "Example study sentence." }],
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenerationError);
    expect(error).toMatchObject({ code: "render_limit", retryable: false });
    expect((error as Error).message).toContain(reason);
    expect(classifyGenerationError(error).code).toBe("render_limit");
    expect(publicGenerationErrorMessage("render_limit", (error as Error).message)).toBe(
      "This came out too long or too math-heavy to display. Try generating it again.",
    );
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
