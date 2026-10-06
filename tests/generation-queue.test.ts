import { describe, expect, it } from "vitest";

import {
  BATCH_ACCEPT,
  canStartPack,
  isBatchFile,
  nextRunnable,
  packNameFromFilename,
  QUEUE_MIN_REQUESTS,
  queuedRunOutcome,
  queueRowLabel,
  queueRowState,
  resetCopy,
  type QueueRunner,
} from "@/lib/generation-queue";

const idle: QueueRunner = { runningId: null, step: null, waiting: false, failedIds: new Set() };

function pack(
  id: string,
  values: { ready?: boolean; activeJobId?: string | null; failed?: boolean } = {},
) {
  return {
    id,
    ready: values.ready ?? true,
    activeJobId: values.activeJobId ?? null,
    failed: values.failed ?? false,
  };
}

describe("packNameFromFilename", () => {
  it("drops the extension and tidies whitespace", () => {
    expect(packNameFromFilename("Trans 5  Cardiac\tcycle.pdf")).toBe("Trans 5 Cardiac cycle");
    expect(packNameFromFilename("notes.v2.final.docx")).toBe("notes.v2.final");
    expect(packNameFromFilename("  README  ")).toBe("README");
  });

  it("keeps a leading-dot name and falls back when empty", () => {
    expect(packNameFromFilename(".md")).toBe(".md");
    expect(packNameFromFilename("   .pdf")).toBe("Untitled pack");
  });

  it("caps the name at 200 characters", () => {
    const name = packNameFromFilename(`${"a".repeat(250)}.txt`);
    expect(name).toHaveLength(200);
  });
});

describe("isBatchFile", () => {
  it.each(["a.pdf", "b.DOCX", "c.pptx", "d.txt", "e.md"])("accepts %s", (name) => {
    expect(isBatchFile({ name })).toBe(true);
  });

  it.each(["photo.jpg", "scan.heic", "lecture.mp4", "voice.m4a", "deck.ppt", "noextension"])(
    "skips %s",
    (name) => {
      expect(isBatchFile({ name })).toBe(false);
    },
  );

  it("limits the picker to the same document types", () => {
    for (const extension of [".pdf", ".docx", ".pptx", ".txt", ".md"]) {
      expect(BATCH_ACCEPT).toContain(extension);
    }
    expect(BATCH_ACCEPT).not.toMatch(/image|audio|video/);
  });
});

describe("nextRunnable", () => {
  it("takes the oldest ready pack", () => {
    expect(nextRunnable([pack("a", { ready: false }), pack("b"), pack("c")])?.id).toBe("b");
  });

  it("adopts a pack whose job is already active before starting another", () => {
    expect(nextRunnable([pack("a"), pack("b", { activeJobId: "job-b" })])?.id).toBe("b");
  });

  it("never picks a pack whose run stopped since it was queued", () => {
    expect(nextRunnable([pack("a", { failed: true }), pack("b")])?.id).toBe("b");
    expect(nextRunnable([pack("a", { failed: true })])).toBeNull();
  });

  it("skips packs that failed in this visit and returns null when nothing runs", () => {
    expect(nextRunnable([pack("a"), pack("b")], new Set(["a"]))?.id).toBe("b");
    expect(nextRunnable([pack("a", { ready: false })])).toBeNull();
    expect(nextRunnable([])).toBeNull();
  });
});

describe("queuedRunOutcome", () => {
  const queuedAt = new Date("2026-10-06T01:00:00.000Z");
  const after = new Date("2026-10-06T01:05:00.000Z");
  const before = new Date("2026-10-06T00:55:00.000Z");
  const job = (status: string, finishedAt: Date | null, active = false) => ({ status, active, finishedAt });

  it("marks a failed or partial run that ended after queueing as stopped", () => {
    expect(queuedRunOutcome(job("failed", after), queuedAt)).toBe("stopped");
    expect(queuedRunOutcome(job("partial", after), queuedAt)).toBe("stopped");
    expect(queuedRunOutcome(job("partial", queuedAt), queuedAt)).toBe("stopped");
  });

  it("treats a run that succeeded after queueing as done", () => {
    expect(queuedRunOutcome(job("succeeded", after), queuedAt)).toBe("succeeded");
  });

  it("ignores runs that ended before queueing (Retry stamps a new time) or are still active", () => {
    expect(queuedRunOutcome(job("failed", before), queuedAt)).toBeNull();
    expect(queuedRunOutcome(job("succeeded", before), queuedAt)).toBeNull();
    expect(queuedRunOutcome(job("running", null, true), queuedAt)).toBeNull();
    expect(queuedRunOutcome(job("partial", after, true), queuedAt)).toBeNull();
    expect(queuedRunOutcome(null, queuedAt)).toBeNull();
  });
});

describe("canStartPack", () => {
  it("needs a full pack's worth of requests and never runs blind", () => {
    expect(QUEUE_MIN_REQUESTS).toBe(14);
    expect(canStartPack(14)).toBe(true);
    expect(canStartPack(50)).toBe(true);
    expect(canStartPack(13)).toBe(false);
    expect(canStartPack(0)).toBe(false);
    expect(canStartPack(null)).toBe(false);
    expect(canStartPack(undefined)).toBe(false);
  });
});

describe("queueRowState", () => {
  it("shows the running pack's step out of four", () => {
    const state = queueRowState(pack("a"), { ...idle, runningId: "a", step: "summary" });
    expect(state).toEqual({ kind: "generating", step: "summary", index: 2, total: 4 });
    expect(queueRowLabel(state)).toBe("Generating Summary (2 of 4)");
    expect(queueRowLabel(queueRowState(pack("a"), { ...idle, runningId: "a", step: "locked_in" })))
      .toBe("Generating Locked In (1 of 4)");
  });

  it("marks waiting, failed, unreadable and queued rows", () => {
    expect(queueRowState(pack("a"), { ...idle, waiting: true })).toEqual({ kind: "waiting" });
    expect(queueRowState(pack("a"), { ...idle, failedIds: new Set(["a"]) })).toEqual({ kind: "failed" });
    expect(queueRowState(pack("a", { failed: true }), { ...idle, waiting: true })).toEqual({ kind: "failed" });
    expect(queueRowState(pack("a", { ready: false }), idle)).toEqual({ kind: "unreadable" });
    expect(queueRowState(pack("a"), idle)).toEqual({ kind: "queued" });
  });

  it("uses the agreed copy without em dashes", () => {
    const labels = [
      queueRowLabel({ kind: "uploading" }),
      queueRowLabel({ kind: "reading" }),
      queueRowLabel({ kind: "queued" }),
      queueRowLabel({ kind: "waiting" }),
      queueRowLabel({ kind: "failed" }),
      queueRowLabel({ kind: "unreadable" }),
    ];
    expect(labels).toEqual([
      "Uploading",
      "Reading",
      "Queued",
      "Waiting for tomorrow's free requests (resets 8:00 AM)",
      "Could not generate",
      "Could not read this file",
    ]);
    expect(resetCopy()).toBe("resets 8:00 AM");
    for (const label of labels) expect(label).not.toContain("—");
  });
});
