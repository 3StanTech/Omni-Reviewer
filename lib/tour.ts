/**
 * Kirby's first-visit tour: steps, copy and the pure rule that picks the step from
 * what the app reports. Progress lives in a small device record (`omni-tour`); every
 * reload or navigation recomputes the step from facts, never from memory.
 */

export type TourStepId =
  | "start"
  | "shelf"
  | "topic"
  | "topicDialog"
  | "pack"
  | "packDialog"
  | "upload"
  | "reading"
  | "generate"
  | "generating"
  | "interlude"
  | "locked_in"
  | "summary"
  | "test_me"
  | "carded"
  | "ask"
  | "finish";

export type TourTarget =
  | "shelf-toggle"
  | "new-topic"
  | "topic-dialog"
  | "topics"
  | "new-pack"
  | "pack-dialog"
  | "upload"
  | "paste"
  | "source-row"
  | "generate"
  | "study-pack-kirby"
  | "tab-locked_in"
  | "tab-summary"
  | "tab-test_me"
  | "tab-carded"
  | "ask";

export type TourStep = {
  /** The lit control, or null for a centred bubble (start, finish). */
  target: TourTarget | null;
  part: 1 | 2 | null;
  /** "Step N of 9"; null hides the progress line. */
  number: number | null;
  title: string;
  line: string;
  /** A link in the bubble that presses another control instead. */
  link?: { label: string; target: TourTarget };
  /** No veil: the page stays usable (4b). */
  open?: boolean;
};

export const TOUR_TOTAL = 9;

export const TOUR_PART_TITLES = {
  1: "Set up your first pack",
  2: "Your study modes",
} as const;

export const TOUR_STEPS: Record<TourStepId, TourStep> = {
  start: {
    target: null,
    part: null,
    number: null,
    title: "Want a quick tour?",
    line: "I'll show you how to make your first study pack, one step at a time.",
  },
  shelf: {
    target: "shelf-toggle",
    part: 1,
    number: 1,
    title: "Make a topic",
    line: "Topics live in the shelf. Open it, then press +.",
  },
  topic: {
    target: "new-topic",
    part: 1,
    number: 1,
    title: "Make a topic",
    line: "A topic holds one subject, like Microbiology. Press + to make your first one.",
  },
  topicDialog: {
    target: "topic-dialog",
    part: 1,
    number: 1,
    title: "Name your topic",
    line: "Type the subject, like Microbiology, then press Create topic.",
  },
  pack: {
    target: "new-pack",
    part: 1,
    number: 2,
    title: "Add a pack",
    line: "Nice! Now press New pack. One pack is one lecture.",
  },
  packDialog: {
    target: "pack-dialog",
    part: 1,
    number: 2,
    title: "Name your pack",
    line: "Name it after the lecture, like MIC LAB LE3 01, then press Create pack.",
  },
  upload: {
    target: "upload",
    part: 1,
    number: 3,
    title: "Add your handout",
    line: "Press Upload and pick this lecture's handout. PDFs, slides and photos of pages all work.",
    link: { label: "Paste text instead", target: "paste" },
  },
  reading: {
    target: "source-row",
    part: 1,
    number: 3,
    title: "Reading your handout",
    line: "Reading it now. Generate wakes up when this says Ready.",
  },
  generate: {
    target: "generate",
    part: 1,
    number: 4,
    title: "Make your study pack",
    line: "Your handout is Ready. Press Generate and I'll turn it into four study modes. It takes about 3 to 5 minutes.",
  },
  generating: {
    target: "study-pack-kirby",
    part: 1,
    number: 4,
    title: "Generating",
    line: "Inhaling your handout... Please wait poyo moment.",
    open: true,
  },
  interlude: {
    target: null,
    part: null,
    number: null,
    title: "",
    line: "",
    open: true,
  },
  locked_in: {
    target: "tab-locked_in",
    part: 2,
    number: 5,
    title: "Locked In",
    line: "Your full study document, in lecture order. Read it first. Open Locked In.",
  },
  summary: {
    target: "tab-summary",
    part: 2,
    number: 6,
    title: "Summary",
    line: "The short version for last-minute review. Open Summary.",
  },
  test_me: {
    target: "tab-test_me",
    part: 2,
    number: 7,
    title: "Test Me",
    line: "Sit the exam: one question at a time, scored for you. Open Test Me.",
  },
  carded: {
    target: "tab-carded",
    part: 2,
    number: 8,
    title: "Carded",
    line: "Flashcards that come back right before you'd forget. Open Carded.",
  },
  ask: {
    target: "ask",
    part: 2,
    number: 9,
    title: "Ask",
    line: "Stuck on something? Ask me about this lecture and I'll point to the page. Press Ask.",
  },
  finish: {
    target: null,
    part: null,
    number: null,
    title: "That's the tour!",
    line: "Your desk shows what's due each day. Poyo!",
  },
};

/** Part 2, in order; `TourRecord.part2` counts how many are done. */
export const PART_TWO: TourStepId[] = ["locked_in", "summary", "test_me", "carded", "ask"];

export const REPLAY_START = {
  title: "Want the tour again?",
  line: "I'll show you each part again. Press Next to move along, or Skip tour anytime.",
} as const;

/** Show-me stops for the replay: nothing is created, Back and Next move between them. */
export const REPLAY_STOPS: { id: string; page: "desk" | "pack"; step: TourStepId; target: TourTarget }[] = [
  { id: "topics", page: "desk", step: "topic", target: "topics" },
  { id: "new-pack", page: "desk", step: "pack", target: "new-pack" },
  { id: "tab-locked_in", page: "pack", step: "locked_in", target: "tab-locked_in" },
  { id: "tab-summary", page: "pack", step: "summary", target: "tab-summary" },
  { id: "tab-test_me", page: "pack", step: "test_me", target: "tab-test_me" },
  { id: "tab-carded", page: "pack", step: "carded", target: "tab-carded" },
  { id: "ask", page: "pack", step: "ask", target: "ask" },
];

export type TourPackFacts = {
  id: string;
  /** This pack is the one the tour made (or adopted) for her first visit. */
  isTourPack: boolean;
  /** Sources that are not failed. */
  liveSources: number;
  readySources: number;
  generating: boolean;
  hasViews: boolean;
  /** The first-pack cheer is on screen. */
  cheerActive: boolean;
};

export type TourFacts = {
  page: "desk" | "pack" | "other";
  shelfOpen: boolean;
  dialog: "topic" | "pack" | null;
  topics: number;
  packs: number;
  generatedPacks: number;
  /** Desk only: the newest generated pack, for the replay. */
  latestGeneratedPackHref: string | null;
  pack: TourPackFacts | null;
};

export const EMPTY_TOUR_FACTS: TourFacts = {
  page: "other",
  shelfOpen: false,
  dialog: null,
  topics: 0,
  packs: 0,
  generatedPacks: 0,
  latestGeneratedPackHref: null,
  pack: null,
};

export type TourStatus = "running" | "done" | "skipped";

export type TourRecord = {
  status: TourStatus;
  /** The pack made in step 2b; Part 2 runs only there. */
  packId?: string;
  /** How many Part 2 stops are done (0-5). */
  part2?: number;
};

export const TOUR_KEYS = {
  record: "omni-tour",
  muted: "omni-tour-muted",
} as const;

export function parseTourRecord(raw: string | null): TourRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.status !== "running" && value.status !== "done" && value.status !== "skipped") return null;
    const record: TourRecord = { status: value.status };
    if (typeof value.packId === "string" && value.packId) record.packId = value.packId;
    if (typeof value.part2 === "number" && Number.isInteger(value.part2)) {
      record.part2 = Math.min(Math.max(value.part2, 0), PART_TWO.length);
    }
    return record;
  } catch {
    return null;
  }
}

export function serializeTourRecord(record: TourRecord): string {
  return JSON.stringify(record);
}

/**
 * The step to show, or null for none. Desk: shelf, topic, pack and their dialogs.
 * Pack page (the tour's own pack only): source, reading, Generate, the wait, the
 * cheer, then the study modes in order and the finish.
 */
export function tourStep(record: TourRecord | null, facts: TourFacts): TourStepId | null {
  if (facts.page === "other") return null;
  if (!record) {
    return facts.page === "desk" && facts.generatedPacks === 0 ? "start" : null;
  }
  if (record.status !== "running") return null;

  if (facts.page === "desk") {
    // The dialogs are setup steps: after setup, opening one again is her own errand.
    if (facts.dialog === "topic" && facts.topics === 0) return "topicDialog";
    if (facts.dialog === "pack" && facts.packs === 0) return "packDialog";
    if (facts.topics === 0) return facts.shelfOpen ? "topic" : "shelf";
    if (facts.packs === 0) return "pack";
    return null;
  }

  const pack = facts.pack;
  if (!pack || !pack.isTourPack) return null;
  if (pack.liveSources === 0) return "upload";
  if (pack.readySources === 0) return "reading";
  if (pack.generating) return "generating";
  if (!pack.hasViews) return "generate";
  if (pack.cheerActive) return "interlude";
  const done = record.part2 ?? 0;
  return done >= PART_TWO.length ? "finish" : PART_TWO[done];
}
