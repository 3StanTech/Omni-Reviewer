import { describe, expect, it } from "vitest";

import {
  EMPTY_TOUR_FACTS,
  parseTourRecord,
  tourStep,
  type TourFacts,
  type TourPackFacts,
  type TourRecord,
} from "@/lib/tour";

const desk = (over: Partial<TourFacts> = {}): TourFacts => ({ ...EMPTY_TOUR_FACTS, page: "desk", ...over });
const pack = (over: Partial<TourPackFacts> = {}): TourFacts => ({
  ...EMPTY_TOUR_FACTS,
  page: "pack",
  pack: {
    id: "p1",
    isTourPack: true,
    liveSources: 1,
    readySources: 1,
    generating: false,
    hasViews: true,
    cheerActive: false,
    ...over,
  },
});
const running: TourRecord = { status: "running", packId: "p1" };

describe("tourStep", () => {
  it.each<[string, TourRecord | null, TourFacts, string | null]>([
    ["fresh desk offers the tour", null, desk(), "start"],
    ["desk with a generated pack offers nothing", null, desk({ generatedPacks: 1, topics: 1, packs: 1 }), null],
    ["no record on a pack page", null, pack(), null],
    ["skipped", { status: "skipped" }, desk(), null],
    ["done", { status: "done" }, pack(), null],
    ["other page", running, { ...EMPTY_TOUR_FACTS }, null],
    ["shelf closed with no topic", { status: "running" }, desk(), "shelf"],
    ["shelf open with no topic", { status: "running" }, desk({ shelfOpen: true }), "topic"],
    ["topic dialog open", { status: "running" }, desk({ shelfOpen: true, dialog: "topic" }), "topicDialog"],
    ["topic made, no pack", { status: "running" }, desk({ topics: 1 }), "pack"],
    ["pack dialog open", { status: "running" }, desk({ topics: 1, dialog: "pack" }), "packDialog"],
    ["packs exist on the desk", running, desk({ topics: 1, packs: 1 }), null],
    ["New topic opened after setup", running, desk({ topics: 1, packs: 1, dialog: "topic" }), null],
    ["New pack opened after setup", running, desk({ topics: 1, packs: 1, dialog: "pack" }), null],
    ["a pack that is not the tour's", running, pack({ isTourPack: false, liveSources: 0, hasViews: false }), null],
    ["no sources", running, pack({ liveSources: 0, readySources: 0, hasViews: false }), "upload"],
    ["source reading", running, pack({ readySources: 0, hasViews: false }), "reading"],
    ["source ready, not generated", running, pack({ hasViews: false }), "generate"],
    ["generating", running, pack({ generating: true, hasViews: false }), "generating"],
    ["generated with the cheer up", running, pack({ cheerActive: true }), "interlude"],
    ["Part 2 start", running, pack(), "locked_in"],
    ["Part 2 after three", { ...running, part2: 3 }, pack(), "carded"],
    ["Part 2 done", { ...running, part2: 5 }, pack(), "finish"],
  ])("%s", (_name, record, facts, expected) => {
    expect(tourStep(record, facts)).toBe(expected);
  });
});

describe("parseTourRecord", () => {
  it.each<[string | null, TourRecord | null]>([
    [null, null],
    ["not json", null],
    ['{"status":"maybe"}', null],
    ['{"status":"running","packId":"p1","part2":9}', { status: "running", packId: "p1", part2: 5 }],
    ['{"status":"skipped"}', { status: "skipped" }],
  ])("%s", (raw, expected) => {
    expect(parseTourRecord(raw)).toEqual(expected);
  });
});
