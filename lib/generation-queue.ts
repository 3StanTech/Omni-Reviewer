import type { GenerateKind } from "@/lib/generation-plan";

/** A full pack costs about 10-14 free requests; never start one below this. */
export const QUEUE_MIN_REQUESTS = 14;

const MAX_PACK_NAME_CHARS = 200;
const BATCH_EXTENSIONS = ["pdf", "docx", "pptx", "txt", "md"] as const;

/** `accept` for the desk's batch picker: documents only. */
export const BATCH_ACCEPT = [
  ...BATCH_EXTENSIONS.map((extension) => `.${extension}`),
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
].join(",");

const PACK_STEPS: GenerateKind[] = ["locked_in", "summary", "test_me", "carded"];

const STEP_LABELS: Record<GenerateKind, string> = {
  locked_in: "Locked In",
  summary: "Summary",
  test_me: "Test Me",
  carded: "Carded",
};

/** One queued pack as `GET /api/queue` returns it. */
export type QueuedPackItem = {
  id: string;
  topicId: string;
  name: string;
  queuedAt: string;
  ready: boolean;
  reason: "no_ready_source" | null;
  activeJobId: string | null;
  failed: boolean;
  lastError: string | null;
};

/** What the desk's runner is doing right now. */
export type QueueRunner = {
  runningId: string | null;
  step: GenerateKind | null;
  waiting: boolean;
  failedIds: ReadonlySet<string>;
};

export type QueueRowState =
  | { kind: "uploading" }
  | { kind: "reading" }
  | { kind: "unreadable" }
  | { kind: "queued" }
  | { kind: "generating"; step: GenerateKind | null; index: number; total: number }
  | { kind: "waiting" }
  | { kind: "failed" };

/**
 * How the pack's latest run ended since it was queued: "succeeded" (done, so
 * no longer queued), "stopped" (failed or partial: never picked again until
 * Retry stamps a new queue time), or null (nothing finished since queueing).
 */
export function queuedRunOutcome(
  latest: { status: string; active: boolean; finishedAt: Date | null } | null,
  queuedAt: Date,
): "succeeded" | "stopped" | null {
  if (!latest || latest.active || latest.finishedAt === null) return null;
  if (latest.finishedAt.getTime() < queuedAt.getTime()) return null;
  if (latest.status === "succeeded") return "succeeded";
  if (latest.status === "failed" || latest.status === "partial") return "stopped";
  return null;
}

/** The pack name for one batch file: its name without the extension. */
export function packNameFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const name = base.replace(/\s+/g, " ").trim().slice(0, MAX_PACK_NAME_CHARS).trim();
  return name || "Untitled pack";
}

/** Documents only: photo sets need grouping and media is not read in v1. */
export function isBatchFile(file: Pick<File, "name">): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(file.name);
  if (!match) return false;
  return (BATCH_EXTENSIONS as readonly string[]).includes(match[1]!.toLowerCase());
}

/**
 * The next pack the runner should drive. A pack whose job is already active
 * goes first (adopt it rather than start another); then the oldest ready one.
 * Packs that failed in this visit wait for an explicit Retry.
 */
export function nextRunnable<
  T extends Pick<QueuedPackItem, "id" | "ready" | "activeJobId" | "failed">,
>(
  packs: readonly T[],
  failedIds: ReadonlySet<string> = new Set(),
): T | null {
  const eligible = packs.filter((pack) => !pack.failed && !failedIds.has(pack.id));
  return eligible.find((pack) => pack.activeJobId)
    ?? eligible.find((pack) => pack.ready)
    ?? null;
}

/** True when the day's free requests cover one more pack. Unknown never runs. */
export function canStartPack(remaining: number | null | undefined): boolean {
  return typeof remaining === "number" && remaining >= QUEUE_MIN_REQUESTS;
}

/** Display state of one queued pack under the current runner. */
export function queueRowState(
  pack: Pick<QueuedPackItem, "id" | "ready" | "activeJobId" | "failed">,
  runner: QueueRunner,
): QueueRowState {
  if (pack.failed || runner.failedIds.has(pack.id)) return { kind: "failed" };
  if (runner.runningId === pack.id) {
    const index = runner.step ? PACK_STEPS.indexOf(runner.step) + 1 : 1;
    return { kind: "generating", step: runner.step, index, total: PACK_STEPS.length };
  }
  if (!pack.ready && !pack.activeJobId) return { kind: "unreadable" };
  return runner.waiting ? { kind: "waiting" } : { kind: "queued" };
}

export function resetCopy(): string {
  return "resets 8:00 AM";
}

export function queueRowLabel(state: QueueRowState): string {
  switch (state.kind) {
    case "uploading":
      return "Uploading";
    case "reading":
      return "Reading";
    case "unreadable":
      return "Could not read this file";
    case "queued":
      return "Queued";
    case "generating":
      return state.step
        ? `Generating ${STEP_LABELS[state.step]} (${state.index} of ${state.total})`
        : "Generating";
    case "waiting":
      return `Waiting for tomorrow's free requests (${resetCopy()})`;
    case "failed":
      return "Could not generate";
  }
}
