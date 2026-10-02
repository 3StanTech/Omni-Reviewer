/**
 * Replay grounding against a local fixture without changing stored documents.
 *
 * Usage:
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/replay-grounding.ts <fixture.json> [--lexical-only] [--as-check-again | --retest-tags]
 *
 * Fixture: { markdown: string, sources: [{ index: number, text: string }],
 *            uncheckedKeys?: string[], unchecked?: number }.
 * Source text keeps its stored <<<page N>>> markers.
 * --lexical-only makes no model requests. Live mode uses the production verifier.
 * --as-check-again rechecks tags and recorded uncheckedKeys; if keys are absent,
 *   unchecked > 0 enables the legacy recheck of every untagged lexical miss.
 * --retest-tags removes all tokens before a normal pass, like fresh generation.
 * --as-check-again and --retest-tags are mutually exclusive.
 */

import { readFile } from "node:fs/promises";

import { claimSentences, stripCitations, UNSOURCED_TOKEN } from "@/lib/citations";
import {
  groundDocument,
  normalizeForMatch,
  type GroundingSource,
  type VerifyFn,
  type VerifyItem,
} from "@/lib/grounding";
import { MAX_GROUNDING_EVIDENCE_CHARS, MAX_GROUNDING_VERIFY_ITEMS } from "@/lib/learning-limits";

type Fixture = { markdown: string; sources: GroundingSource[]; uncheckedKeys?: string[]; unchecked?: number };

function usage(): never {
  console.error(
    "Usage: npx tsx --env-file=.env.local --conditions=react-server scripts/replay-grounding.ts <fixture.json> [--lexical-only] [--as-check-again | --retest-tags]",
  );
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readFixture(file: string): Promise<Fixture> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new Error("Could not read fixture file. Check the path and read permissions.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid fixture: expected valid JSON.");
  }
  if (!isRecord(value)) throw new Error("Invalid fixture: expected a JSON object.");
  if (typeof value.markdown !== "string") throw new Error("Invalid fixture: markdown must be a string.");
  if (!Array.isArray(value.sources)) throw new Error("Invalid fixture: sources must be an array.");

  const indices = new Set<number>();
  const sources = value.sources.map((source: unknown, position: number): GroundingSource => {
    const field = `sources[${position}]`;
    if (!isRecord(source)) throw new Error(`Invalid fixture: ${field} must be an object.`);
    if (typeof source.index !== "number" || !Number.isSafeInteger(source.index) || source.index < 1) {
      throw new Error(`Invalid fixture: ${field}.index must be a positive integer.`);
    }
    if (indices.has(source.index)) throw new Error(`Invalid fixture: ${field}.index must be unique.`);
    if (typeof source.text !== "string") throw new Error(`Invalid fixture: ${field}.text must be a string.`);
    indices.add(source.index);
    return { index: source.index, text: source.text };
  });
  let uncheckedKeys: string[] | undefined;
  if (value.uncheckedKeys !== undefined) {
    if (!Array.isArray(value.uncheckedKeys) || value.uncheckedKeys.length > 500 || value.uncheckedKeys.some((key: unknown) => typeof key !== "string" || key.length > 16)) {
      throw new Error("Invalid fixture: uncheckedKeys must be an array of at most 500 strings, each at most 16 characters.");
    }
    uncheckedKeys = value.uncheckedKeys;
  }
  if (value.unchecked !== undefined && (typeof value.unchecked !== "number" || !Number.isSafeInteger(value.unchecked) || value.unchecked < 0)) {
    throw new Error("Invalid fixture: unchecked must be a non-negative integer.");
  }
  return {
    markdown: value.markdown, sources,
    ...(uncheckedKeys !== undefined ? { uncheckedKeys } : {}),
    ...(value.unchecked !== undefined ? { unchecked: value.unchecked as number } : {}),
  };
}

async function liveVerify(): Promise<VerifyFn> {
  const ai = await import("@/lib/ai").catch(() => {
    // Provider/import errors can contain configuration; never print them.
    throw new Error("Could not load the live verifier. Run with --conditions=react-server and the required environment, or use --lexical-only.");
  });
  if (!("replayVerify" in ai) || typeof ai.replayVerify !== "function") {
    throw new Error("Live replay is unavailable: @/lib/ai does not export replayVerify yet. Use --lexical-only until the verifier export lands.");
  }
  return ai.replayVerify as VerifyFn;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = ["--lexical-only", "--as-check-again", "--retest-tags"];
  const lexicalOnly = args.includes("--lexical-only");
  const asCheckAgain = args.includes("--as-check-again");
  const retestTags = args.includes("--retest-tags");
  const positional = args.filter((arg) => !flags.includes(arg));
  if (positional.length !== 1 || !positional[0] || positional[0].startsWith("-") || flags.some((flag) => args.filter((arg) => arg === flag).length > 1)) {
    usage();
  }
  if (asCheckAgain && retestTags) throw new Error("Choose either --as-check-again or --retest-tags; they cannot be combined.");

  const fixture = await readFixture(positional[0]);
  const verify: VerifyFn = lexicalOnly
    ? async () => { throw new Error("Lexical-only replay: verifier disabled."); }
    : await liveVerify();
  const captured: VerifyItem[] = [];
  const result = await groundDocument({
    markdown: retestTags ? fixture.markdown.replace(/ ?\[\[unsourced\]\]/g, "") : fixture.markdown,
    sources: fixture.sources,
    ...(asCheckAgain ? {
      recheck: {
        uncheckedKeys: fixture.uncheckedKeys,
        legacyUnchecked: fixture.uncheckedKeys === undefined && (fixture.unchecked ?? 0) > 0,
      },
    } : {}),
    maxVerifyItems: MAX_GROUNDING_VERIFY_ITEMS,
    maxEvidenceChars: MAX_GROUNDING_EVIDENCE_CHARS,
    verify: async (items) => {
      // A retry uses the same batch, so keep only one copy for diagnostics.
      captured.splice(0, captured.length, ...items);
      return verify(items);
    },
  });

  console.log(JSON.stringify({ ...result.report, unchecked: result.report.unchecked ?? 0 }, null, 2));
  const tagged = claimSentences(result.markdown)
    .filter((claim) => claim.text.includes(UNSOURCED_TOKEN))
    .slice(0, 20)
    .map((claim) => {
      const sentence = stripCitations(claim.text).replaceAll(UNSOURCED_TOKEN, "").replace(/\s+/g, " ").trim();
      const match = captured.find((item) => normalizeForMatch(item.sentence) === normalizeForMatch(sentence));
      return { sentence, evidenceChars: match?.evidence.length ?? null };
    });
  // null means this tagged claim was not submitted (for example, an existing tag).
  console.log(JSON.stringify({ taggedSentences: tagged }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Grounding replay failed.");
  process.exit(1);
});
