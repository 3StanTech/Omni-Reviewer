/**
 * Replay grounding against a local fixture without changing stored documents.
 *
 * Usage:
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/replay-grounding.ts <fixture.json> [--lexical-only] [--as-check-again | --retest-tags]
 *   npx tsx --conditions=react-server scripts/replay-grounding.ts --term-guard <fixture.json>
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/replay-grounding.ts --summary-halves <fixture.json> [--out <summary.md>] [--max-requests <n>]
 *
 * Fixture: { markdown: string, sources: [{ index: number, text: string }],
 *            uncheckedKeys?: string[], unchecked?: number }.
 * Source text keeps its stored <<<page N>>> markers.
 * --lexical-only makes no model requests. Live mode uses the production verifier.
 * --as-check-again rechecks tags and recorded uncheckedKeys; if keys are absent,
 *   unchecked > 0 enables the legacy recheck of every untagged lexical miss.
 * --retest-tags removes all tokens before a normal pass, like fresh generation.
 * --as-check-again and --retest-tags are mutually exclusive.
 * --term-guard makes no model requests and needs no provider environment.
 * --summary-halves calls production generateSummary, allowing at most three
 *   OpenRouter requests by default, including provider retries. --max-requests
 *   accepts integers 1 through 4; requests beyond that limit are never sent.
 *   --out also saves each parsed attempt's raw text immediately to
 *   <summary.md>.attempt-<k>-part-<p>[-strict].md, even if a later request aborts.
 *   Per-half measurements observe provider responses before the final cleanup;
 *   null fields mean the response or its half could not be observed.
 */

import { readFile, writeFile } from "node:fs/promises";

import { claimSentences, repairPageAsSourceCitations, stripCitations, UNSOURCED_TOKEN } from "@/lib/citations";
import {
  groundDocument,
  groundingClaimTexts,
  normalizeForMatch,
  type GroundingSource,
  type VerifyFn,
  type VerifyItem,
} from "@/lib/grounding";
import { MAX_GROUNDING_EVIDENCE_CHARS, MAX_GROUNDING_VERIFY_ITEMS } from "@/lib/learning-limits";
import { splitPages } from "@/lib/source-markers";
import { balancedHalves, splitSections } from "@/lib/study-sections";
import { absentTerms, buildSourceVocabulary } from "@/lib/term-guard";

type Fixture = { markdown: string; sources: GroundingSource[]; uncheckedKeys?: string[]; unchecked?: number };

function usage(): never {
  console.error(
    "Usage: npx tsx --env-file=.env.local --conditions=react-server scripts/replay-grounding.ts <fixture.json> [--lexical-only] [--as-check-again | --retest-tags]",
    "\n       npx tsx --conditions=react-server scripts/replay-grounding.ts --term-guard <fixture.json>",
    "\n       npx tsx --env-file=.env.local --conditions=react-server scripts/replay-grounding.ts --summary-halves <fixture.json> [--out <summary.md>] [--max-requests <n>]",
  );
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readFixture(file: string, requireSources = true): Promise<Fixture> {
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
  if (!requireSources && value.sources === undefined) value.sources = [];
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

async function replayTermGuard(fixture: Fixture) {
  const vocabulary = buildSourceVocabulary(fixture.sources.map((source) => source.text));
  // Each claim's term guard text, exactly as production evaluates it (prose
  // without inline math). Remove tags so tagged claims are included.
  const sentences = groundingClaimTexts(fixture.markdown.replaceAll(UNSOURCED_TOKEN, " ")).map((claim) => claim.termGuardText);
  const termCounts: Record<string, number> = Object.create(null);
  const flaggedSentences = sentences.flatMap((sentence) => {
    const terms = absentTerms(sentence, vocabulary);
    for (const term of terms) termCounts[term] = (termCounts[term] ?? 0) + 1;
    return terms.length > 0 ? [{ sentence: sentence.slice(0, 160), terms }] : [];
  });
  console.log(JSON.stringify({
    claims: sentences.length, flagged: flaggedSentences.length, flaggedSentences, termCounts,
  }, null, 2));
}

type HalfObservation = { k: number; part: number | null; retried: boolean; chars: number | null; finishReason: string | null };

/** Observe only request bodies, never headers (which carry credentials). */
async function summaryRequest(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<{ part: number | null; retried: boolean }> {
  try {
    const raw = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "";
    const body: unknown = JSON.parse(raw);
    const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
    const prompt = messages.flatMap((message: unknown) => {
      if (!isRecord(message)) return [];
      if (typeof message.content === "string") return [message.content];
      if (!Array.isArray(message.content)) return [];
      return message.content.flatMap((part: unknown) => isRecord(part) && typeof part.text === "string" ? [part.text] : []);
    }).join("\n");
    const part = /# Locked In part ([12]) of 2/.exec(prompt)?.[1];
    return {
      part: part ? Number(part) : prompt.includes("# Locked In document") ? 1 : null,
      retried: prompt.includes("Your previous answer was too long or cut off."),
    };
  } catch {
    return { part: null, retried: false };
  }
}

async function replaySummaryHalves(fixture: Fixture, out: string | undefined, maxRequests: number) {
  const lockedIn = fixture.markdown.trim();
  if (!lockedIn) throw new Error("Invalid fixture: Summary replay needs non-empty markdown.");
  const halves = balancedHalves(lockedIn);
  const headings = (markdown: string) => splitSections(markdown).sections.map((section) => section.heading);
  const sectionsInLockedIn = headings(lockedIn);
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const observations: HalfObservation[] = [];
  const pendingWrites: Promise<void>[] = [];
  let requests = 0;
  let capReached = false;
  let summary: string | null = null;
  let failed = false;
  let evidenceWriteFailed = false;

  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
    if (url.hostname !== "openrouter.ai") return originalFetch(input, init);
    if (requests >= maxRequests) {
      capReached = true;
      controller.abort(new Error(`Summary replay stopped before OpenRouter request ${maxRequests + 1} (limit ${maxRequests}).`));
      throw controller.signal.reason;
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    const k = ++requests;
    const observation: HalfObservation = { k, ...await summaryRequest(input, init), chars: null, finishReason: null };
    observations.push(observation);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const response = await originalFetch(input, {
      ...init,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    let rawText: string | null = null;
    try {
      const body: unknown = await response.clone().json();
      const choice: unknown = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : null;
      if (isRecord(choice)) {
        const content = isRecord(choice.message) ? choice.message.content : null;
        rawText = typeof content === "string" ? content : null;
        observation.chars = typeof content === "string" ? content.trim().length : null;
        observation.finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
      }
    } catch {
      // Keep the original response intact for the production SDK to interpret.
    }
    if (out && rawText !== null) {
      const attemptPath = `${out}.attempt-${k}-part-${observation.part ?? "unknown"}${observation.retried ? "-strict" : ""}.md`;
      const write = writeFile(attemptPath, rawText, "utf8");
      pendingWrites.push(write);
      try {
        await write;
      } catch {
        evidenceWriteFailed = true;
        const error = new Error("Could not save Summary attempt evidence; replay stopped.");
        controller.abort(error);
        throw error;
      }
    }
    return response;
  };

  try {
    // Only this explicitly selected live mode imports provider code. Install
    // the hook first so SDK imports cannot capture an uncounted fetch.
    const { generateSummary } = await import("@/lib/ai");
    summary = await generateSummary(lockedIn);
  } catch {
    failed = true;
    controller.abort();
  } finally {
    // On failure Promise.all can leave another half running. Keep the closed
    // hook installed until this CLI exits so that half cannot escape the cap.
    if (!failed) globalThis.fetch = originalFetch;
  }

  // Another half can be writing evidence when Promise.all rejects. Finish
  // those writes before printing the report or exiting on a cap/failure.
  await Promise.allSettled(pendingWrites);
  observations.sort((first, second) => first.k - second.k);
  const sectionsInSummary = summary === null ? [] : headings(summary);
  const attempts = observations.map((observation) => {
    const inputChars = observation.part === null ? null : halves[observation.part - 1]?.length ?? null;
    return {
      k: observation.k, part: observation.part, strict: observation.retried,
      chars: observation.chars, inputChars,
      ratio: observation.chars === null || inputChars === null ? null : observation.chars / inputChars,
      finishReason: observation.finishReason,
    };
  });
  const perHalf = halves.map((half, index) => {
    const matching = observations.filter((observation) => observation.part === index + 1);
    const last = matching.at(-1);
    return {
      chars: last?.chars ?? null,
      inputChars: half.length,
      ratio: last?.chars === null || last?.chars === undefined ? null : last.chars / half.length,
      finishReason: last?.finishReason ?? null,
      retried: matching.length > 0 ? matching.some((observation) => observation.retried) : null,
    };
  });
  console.log(JSON.stringify({
    lockedInChars: lockedIn.length,
    summaryChars: summary?.length ?? null,
    ratio: summary === null ? null : summary.length / lockedIn.length,
    requests, maxRequests, sectionsInLockedIn, sectionsInSummary,
    missingSections: sectionsInLockedIn.filter((heading) => !sectionsInSummary.includes(heading)),
    perHalf, attempts,
    ...(failed ? {
      error: evidenceWriteFailed ? "Could not save Summary attempt evidence; replay stopped."
        : capReached ? `Stopped before OpenRouter request ${maxRequests + 1} (limit ${maxRequests}); no complete Summary was returned.`
        : "Production Summary generation failed; no complete Summary was returned.",
    } : {}),
  }, null, 2));
  if (failed) process.exit(1);
  if (out && summary !== null) await writeFile(out, summary, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const flags = ["--lexical-only", "--as-check-again", "--retest-tags", "--term-guard", "--summary-halves"];
  const lexicalOnly = args.includes("--lexical-only");
  const asCheckAgain = args.includes("--as-check-again");
  const retestTags = args.includes("--retest-tags");
  const termGuard = args.includes("--term-guard");
  const summaryHalves = args.includes("--summary-halves");
  let out: string | undefined;
  let maxRequests: number | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--out") {
      if (out !== undefined || !args[index + 1] || args[index + 1].startsWith("-")) usage();
      out = args[++index];
    } else if (arg === "--max-requests") {
      if (maxRequests !== undefined || !/^[1-4]$/.test(args[index + 1] ?? "")) usage();
      maxRequests = Number(args[++index]);
    } else if (!flags.includes(arg)) positional.push(arg);
  }
  if (positional.length !== 1 || !positional[0] || positional[0].startsWith("-") || flags.some((flag) => args.filter((arg) => arg === flag).length > 1)) {
    usage();
  }
  if (asCheckAgain && retestTags) throw new Error("Choose either --as-check-again or --retest-tags; they cannot be combined.");
  if ((termGuard && summaryHalves) || ((termGuard || summaryHalves) && (lexicalOnly || asCheckAgain || retestTags)) || ((out !== undefined || maxRequests !== undefined) && !summaryHalves)) usage();

  const fixture = await readFixture(positional[0], !summaryHalves);
  if (termGuard) return replayTermGuard(fixture);
  if (summaryHalves) return replaySummaryHalves(fixture, out, maxRequests ?? 3);
  const verify: VerifyFn = lexicalOnly
    ? async () => { throw new Error("Lexical-only replay: verifier disabled."); }
    : await liveVerify();
  const captured: VerifyItem[] = [];
  // Production repairs page-as-source citations before grounding; replay does too.
  const pagesBySource = new Map(
    fixture.sources.map((source) => [
      source.index,
      new Set(splitPages(source.text).map((page) => page.page).filter((page) => page > 0)),
    ]),
  );
  const { text: repairedMarkdown, repaired } = repairPageAsSourceCitations(fixture.markdown, pagesBySource);
  const result = await groundDocument({
    markdown: retestTags ? repairedMarkdown.replace(/ ?\[\[unsourced\]\]/g, "") : repairedMarkdown,
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

  console.log(JSON.stringify({
    ...result.report,
    unchecked: result.report.unchecked ?? 0,
    ...(repaired > 0 ? { repairedCitations: repaired } : {}),
  }, null, 2));
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
