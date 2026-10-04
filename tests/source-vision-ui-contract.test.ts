import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canStartPost,
  changedDecision,
  chunkPages,
  classifyBatchResponse,
  failureDecision,
  isLastTry,
  missingFollowUp,
  progressFor,
  splitBySize,
  unreadableMessage,
  VISION_BATCH_BYTES,
  VISION_BATCH_PAGES,
  VISION_CONCURRENCY,
  VISION_FAILED_MESSAGE,
  VISION_QUOTA_MESSAGE,
  VISION_SOURCE_CHANGED,
  VisionRunner,
  type VisionDeps,
  type VisionProgress,
} from "@/lib/use-source-vision";

const root = path.resolve(__dirname, "..");

type Posted = { sourceId: string; pages: number[]; final: boolean; last: boolean };
type Reply = { status: number; body: unknown } | ((batch: Posted) => { status: number; body: unknown });

/**
 * A fake pages route. Each source keeps a server-side pending list; a POST
 * reads what it is sent unless a scripted reply says otherwise. `failWhen`
 * is an outage (always 502). `rejects` is a page the provider refuses: 502,
 * except on a single page's last try, which the route settles as unreadable.
 */
function harness(
  initial: Record<string, number[]>,
  script: Record<string, Reply[]> = {},
  failWhen?: (batch: Posted) => boolean,
  rejects?: (sourceId: string, page: number) => boolean,
) {
  const pending = new Map(Object.entries(initial).map(([id, pages]) => [id, [...pages]]));
  const posts: Posted[] = [];
  const gets: string[] = [];
  const progress = new Map<string, VisionProgress | null>();
  const textChanged: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const deps: VisionDeps = {
    async getPending(sourceId) {
      gets.push(sourceId);
      return pending.has(sourceId) ? [...pending.get(sourceId)!] : null;
    },
    async loadBytes() {
      return new Uint8Array([1]);
    },
    async *render(_bytes, pages) {
      for (const page of pages) yield { page, blob: new Blob([new Uint8Array(10)]) };
    },
    async post(sourceId, batch) {
      const posted = { sourceId, pages: batch.pages, final: batch.final, last: batch.last };
      posts.push(posted);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      if (failWhen?.(posted)) return { status: 502, body: { error: "Model failed", code: "json_parse" } };
      const scripted = script[sourceId]?.shift();
      if (scripted) return typeof scripted === "function" ? scripted(posted) : scripted;
      if (rejects && batch.pages.some((page) => rejects(sourceId, page))) {
        if (!batch.last) return { status: 502, body: { error: "Model failed", code: "unknown" } };
        const left = (pending.get(sourceId) ?? []).filter((page) => !batch.pages.includes(page));
        pending.set(sourceId, left);
        return { status: 200, body: { read: [], missing: [], pending: left, unreadable: batch.pages } };
      }
      const left = (pending.get(sourceId) ?? []).filter((page) => !batch.pages.includes(page));
      pending.set(sourceId, left);
      return { status: 200, body: { read: batch.pages, missing: [], pending: left } };
    },
    onProgress(sourceId, next) {
      progress.set(sourceId, next);
    },
    onTextChanged(sourceId) {
      textChanged.push(sourceId);
    },
  };
  const runner = new VisionRunner(deps);
  const sources = Object.keys(initial).map((id) => ({
    id,
    kind: "pdf",
    ingestStatus: "ready",
    blobPathname: `${id}.pdf`,
  }));
  return {
    runner,
    posts,
    gets,
    progress,
    pending,
    textChanged,
    get maxInFlight() {
      return maxInFlight;
    },
    async start() {
      await runner.sync(sources);
      await runner.idle();
    },
  };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("slide-image reading decisions", () => {
  it("batches 28 pages into 4 POSTs of at most 8", () => {
    const batches = chunkPages(range(1, 28));
    expect(batches).toHaveLength(4);
    expect(batches.every((batch) => batch.length <= VISION_BATCH_PAGES)).toBe(true);
    expect(batches.flat()).toEqual(range(1, 28));
    expect(VISION_BATCH_PAGES).toBe(8);
  });

  it("caps POSTs in flight at 2", () => {
    expect(VISION_CONCURRENCY).toBe(2);
    expect(canStartPost(0)).toBe(true);
    expect(canStartPost(1)).toBe(true);
    expect(canStartPost(2)).toBe(false);
  });

  it("splits a rendered batch that would exceed the byte cap", () => {
    const big = 800 * 1024;
    const groups = splitBySize(Array.from({ length: 8 }, () => big));
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.length * big).toBeLessThanOrEqual(VISION_BATCH_BYTES);
    }
    expect(groups.flat()).toEqual(range(0, 7));
  });

  it("re-sends missing pages once, marked final", () => {
    const task = { sourceId: "s", pages: [1, 2, 3], final: false, attempt: 0 };
    const follow = missingFollowUp(task, [2]);
    expect(follow).toMatchObject({ pages: [2], final: true });
    expect(missingFollowUp(follow!, [2])).toBeNull();
    expect(missingFollowUp(task, [])).toBeNull();
  });

  it("classifies quota, source-changed, gone and other failures", () => {
    expect(classifyBatchResponse(429, { error: "x", code: "rate_limited" })).toEqual({ kind: "quota" });
    expect(classifyBatchResponse(409, { error: VISION_SOURCE_CHANGED })).toEqual({ kind: "changed" });
    expect(classifyBatchResponse(409, { error: "Only a ready PDF can have its slide images read" }))
      .toEqual({ kind: "gone" });
    expect(classifyBatchResponse(404, {})).toEqual({ kind: "gone" });
    for (const status of [0, 400, 413, 422, 500, 502]) {
      expect(classifyBatchResponse(status, { error: "x" })).toEqual({ kind: "failed" });
    }
    expect(classifyBatchResponse(200, { read: [1], missing: [2], pending: [2, 5] }))
      .toEqual({ kind: "ok", read: [1], missing: [2], pending: [2, 5], unreadable: [] });
    expect(classifyBatchResponse(200, { read: [], missing: [], pending: [], unreadable: [6] }))
      .toMatchObject({ kind: "ok", unreadable: [6] });
  });

  it("halves a failed batch down to single pages, retrying only a lone page once", () => {
    const task = { sourceId: "s", pages: range(1, 8), final: false, attempt: 0 };
    const first = failureDecision(task);
    expect(first.kind).toBe("split");
    if (first.kind !== "split") return;
    expect(first.halves.map((half) => half.pages)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    const odd = failureDecision({ ...task, pages: [1, 2, 3] });
    expect(odd.kind === "split" && odd.halves.map((half) => half.pages)).toEqual([[1, 2], [3]]);
    // A page reached by halving already failed once: give up, no identical resend.
    expect(failureDecision({ ...task, pages: [3], attempt: 1 })).toEqual({ kind: "give_up" });
    // A page sent alone from the start gets one more try.
    expect(failureDecision({ ...task, pages: [9] })).toMatchObject({ kind: "retry", task: { pages: [9], attempt: 1 } });
    // Only a single page on its last allowed try is marked last.
    expect(isLastTry({ ...task, pages: [3], attempt: 1 })).toBe(true);
    expect(isLastTry({ ...task, pages: [9], attempt: 0 })).toBe(false);
    expect(isLastTry({ ...task, pages: [1, 2], attempt: 1 })).toBe(false);
    expect(changedDecision(false)).toBe("refetch");
    expect(changedDecision(true)).toBe("stop");
  });

  it("keeps rendered images with their halves", () => {
    const images = [1, 2, 3, 4].map((n) => new Blob([new Uint8Array(n)]));
    const decision = failureDecision({ sourceId: "s", pages: [1, 2, 3, 4], final: false, attempt: 0, images });
    expect(decision.kind === "split" && decision.halves.map((half) => half.images?.map((image) => image.size)))
      .toEqual([[1, 2], [3, 4]]);
  });

  it("counts progress from the server's pending list", () => {
    expect(progressFor(24, range(17, 24))).toEqual({ done: 16, total: 24 });
    expect(progressFor(24, [])).toEqual({ done: 24, total: 24 });
  });
});

describe("VisionRunner", () => {
  it("reads every pending page with at most 2 POSTs in flight across sources", async () => {
    const h = harness({ a: range(1, 28), b: range(1, 20) });
    await h.start();
    expect(h.gets.sort()).toEqual(["a", "b"]);
    expect(h.posts.every((post) => post.pages.length <= VISION_BATCH_PAGES)).toBe(true);
    expect(h.posts.filter((post) => post.sourceId === "a")).toHaveLength(4);
    expect(h.maxInFlight).toBeLessThanOrEqual(VISION_CONCURRENCY);
    expect(h.maxInFlight).toBe(2);
    expect(h.progress.get("a")).toEqual({ state: "done", done: 28, total: 28 });
    expect(h.textChanged.sort()).toEqual(["a", "b"]);
  });

  it("GETs each source once per session", async () => {
    const h = harness({ a: [1] });
    await h.start();
    await h.start();
    expect(h.gets).toEqual(["a"]);
  });

  it("sends missing pages again with final, then trusts the server", async () => {
    const h = harness({ a: [1, 2, 3] }, {
      a: [
        () => {
          h.pending.set("a", [2]);
          return { status: 200, body: { read: [1, 3], missing: [2], pending: [2] } };
        },
      ],
    });
    await h.start();
    expect(h.posts).toEqual([
      { sourceId: "a", pages: [1, 2, 3], final: false, last: false },
      { sourceId: "a", pages: [2], final: true, last: false },
    ]);
    expect(h.progress.get("a")?.state).toBe("done");
  });

  it("stops every queue on a 429 with the quota message", async () => {
    const quota = { status: 429, body: { error: "Rate limited", code: "rate_limited" } };
    const h = harness({ a: range(1, 40), b: range(1, 40) }, { a: [quota] });
    await h.start();
    for (const id of ["a", "b"]) {
      expect(h.progress.get(id)).toMatchObject({ state: "stopped", message: VISION_QUOTA_MESSAGE });
    }
    // Nothing new starts after the stop; at most the other runner's batch was already out.
    expect(h.posts.length).toBeLessThanOrEqual(3);
  });

  it("isolates one bad page by halving, reads the rest, then stops that source only", async () => {
    const bad = 3;
    const h = harness({ a: range(1, 8), b: [1] }, {}, (batch) => batch.sourceId === "a" && batch.pages.includes(bad));
    await h.start();
    const aPosts = h.posts.filter((p) => p.sourceId === "a").map((p) => p.pages);
    // Two runners interleave, so compare the set of batches sent.
    const key = (pages: number[]) => pages.join(",");
    expect(aPosts.map(key).sort()).toEqual(
      [range(1, 8), [1, 2, 3, 4], range(5, 8), [1, 2], [3, 4], [3], [4]].map(key).sort(),
    );
    // No identical batch is ever sent twice.
    expect(new Set(aPosts.map((pages) => pages.join(","))).size).toBe(aPosts.length);
    expect(h.pending.get("a")).toEqual([bad]);
    expect(h.progress.get("a")).toMatchObject({ state: "stopped", message: VISION_FAILED_MESSAGE, done: 7, total: 8 });
    expect(h.progress.get("b")?.state).toBe("done");

    h.runner.retry("a");
    await h.runner.idle();
    expect(h.progress.get("a")?.state).toBe("stopped");
  });

  it("costs at most 15 posts when every page of 8 fails", async () => {
    const fail = { status: 502, body: { error: "Model failed" } };
    const h = harness({ a: range(1, 8) }, { a: Array.from({ length: 40 }, () => fail) });
    await h.start();
    expect(h.posts).toHaveLength(15);
    expect(h.progress.get("a")).toMatchObject({ state: "stopped", message: VISION_FAILED_MESSAGE });
  });

  it("retries a lone failed page once", async () => {
    const h = harness({ a: [1] }, { a: [{ status: 500, body: {} }] });
    await h.start();
    expect(h.posts).toHaveLength(2);
    expect(h.progress.get("a")?.state).toBe("done");

    const twice = harness({ a: [1] }, { a: [{ status: 500, body: {} }, { status: 500, body: {} }] });
    await twice.start();
    expect(twice.posts).toHaveLength(2);
    expect(twice.progress.get("a")).toMatchObject({ state: "stopped", message: VISION_FAILED_MESSAGE });
  });

  it("settles a page the provider keeps refusing and finishes the source", async () => {
    const bad = 6;
    const h = harness({ a: range(1, 8), b: [1] }, {}, undefined, (id, page) => id === "a" && page === bad);
    await h.start();
    const aPosts = h.posts.filter((p) => p.sourceId === "a");
    const key = (pages: number[]) => pages.join(",");
    expect(aPosts.map((p) => key(p.pages)).sort()).toEqual(
      [range(1, 8), range(1, 4), range(5, 8), [5, 6], [7, 8], [5], [6]].map(key).sort(),
    );
    // Only the single page's last try is marked, and it is never sent again.
    expect(aPosts.filter((p) => p.last).map((p) => p.pages)).toEqual([[5], [6]]);
    expect(aPosts.length).toBeLessThanOrEqual(15);
    expect(h.pending.get("a")).toEqual([]);
    expect(h.progress.get("a")).toEqual({
      state: "done",
      done: 8,
      total: 8,
      message: "Page 6 could not be read.",
      unreadable: [6],
    });
    expect(h.progress.get("b")).toEqual({ state: "done", done: 1, total: 1 });
    expect(h.textChanged.sort()).toEqual(["a", "b"]);
  });

  it("costs no more than 15 posts when the provider refuses all 8 pages", async () => {
    const h = harness({ a: range(1, 8) }, {}, undefined, () => true);
    await h.start();
    expect(h.posts).toHaveLength(15);
    expect(h.posts.filter((p) => p.last)).toHaveLength(8);
    expect(h.progress.get("a")).toMatchObject({ state: "done", unreadable: range(1, 8) });
    expect(h.progress.get("a")?.message).toBe("Pages 1, 2, 3, 4, 5, 6, 7 and 8 could not be read.");
  });

  it("gives a lone refused page its one retry as the last try", async () => {
    const h = harness({ a: [4] }, {}, undefined, () => true);
    await h.start();
    expect(h.posts).toEqual([
      { sourceId: "a", pages: [4], final: false, last: false },
      { sourceId: "a", pages: [4], final: false, last: true },
    ]);
    expect(h.progress.get("a")).toMatchObject({ state: "done", unreadable: [4], message: "Page 4 could not be read." });
  });

  it("still halts every source on a 429 during a last try", async () => {
    const quota = { status: 429, body: { error: "Rate limited", code: "rate_limited" } };
    const h = harness({ a: [1], b: range(1, 3) }, { a: [{ status: 502, body: {} }, quota] });
    await h.start();
    expect(h.posts.filter((p) => p.sourceId === "a").map((p) => p.last)).toEqual([false, true]);
    expect(h.progress.get("a")).toMatchObject({ state: "stopped", message: VISION_QUOTA_MESSAGE });
  });

  it("re-GETs the pending list once when the source changed", async () => {
    const changed = { status: 409, body: { error: VISION_SOURCE_CHANGED } };
    const h = harness({ a: range(1, 3) }, { a: [changed] });
    await h.start();
    expect(h.gets).toEqual(["a", "a"]);
    expect(h.progress.get("a")?.state).toBe("done");

    const twice = harness({ a: [1] }, { a: [changed, changed] });
    await twice.start();
    expect(twice.gets).toEqual(["a", "a"]);
    expect(twice.progress.get("a")).toMatchObject({ state: "stopped", message: VISION_FAILED_MESSAGE });
  });

  it("stops quietly on dispose", async () => {
    const h = harness({ a: range(1, 40) });
    const started = h.runner.sync([{ id: "a", kind: "pdf", ingestStatus: "ready", blobPathname: "a.pdf" }]);
    await started;
    h.runner.dispose();
    await h.runner.idle();
    expect(h.runner.signal.aborted).toBe(true);
    expect(h.posts.length).toBeLessThanOrEqual(VISION_CONCURRENCY);
  });
});

describe("slide-image reading copy", () => {
  const files = [
    "lib/use-source-vision.ts",
    "components/view-tabs.tsx",
    "components/source-panel.tsx",
    "components/reviewer-workspace.tsx",
    "components/generation-controls.tsx",
  ];

  it("uses no em dashes in the reading UI", () => {
    const emDash = String.fromCharCode(0x2014);
    for (const file of files) {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text, file).not.toContain(emDash);
    }
  });

  it("keeps the agreed strings", () => {
    const panel = readFileSync(path.join(root, "components/source-panel.tsx"), "utf8");
    const workspace = readFileSync(path.join(root, "components/reviewer-workspace.tsx"), "utf8");
    expect(panel).toContain("Reading slide images: {progress.done} of {progress.total}");
    expect(panel).toContain('aria-live="polite"');
    expect(panel).toContain("Try again");
    expect(panel).toContain(".heic,.heif,image/heic,image/heif");
    expect(panel).toMatch(/PDFs, slides, documents and photos of slides\. Pages that are mostly\s+images are read automatically\./);
    expect(workspace).toContain("Reading slide images first. Generate unlocks when it finishes.");
  });

  it("gates Redo through busyReason without the Redoing spinner", () => {
    const tabs = readFileSync(path.join(root, "components/view-tabs.tsx"), "utf8");
    const workspace = readFileSync(path.join(root, "components/reviewer-workspace.tsx"), "utf8");
    expect(tabs).toContain("busyReason?: string | null;");
    expect(tabs).toContain("const blockReason = busyReason ?? redoBlockReason(tab, views, hasReadySource);");
    expect(tabs).toContain("const redoDisabled = busy || viewsLoading || Boolean(blockReason);");
    // The spinner stays tied to a running generation, not to the reading gate.
    expect(tabs).toMatch(/\{busy \? \(\s*<>\s*<CircleNotch[^]*?Redoing/);
    expect(workspace).toContain("busyReason={busyReason}");
    expect(workspace).toContain("busy={generation.state.busy}");
    expect(VISION_QUOTA_MESSAGE).toBe(
      "The free reading limit is reached for now. Reading picks up the next time you open this pack.",
    );
    expect(VISION_FAILED_MESSAGE).toBe("Could not read some slides.");
  });

  it("names the pages that could not be read", () => {
    expect(unreadableMessage([])).toBeNull();
    expect(unreadableMessage([6])).toBe("Page 6 could not be read.");
    expect(unreadableMessage([9, 3])).toBe("Pages 3 and 9 could not be read.");
    expect(unreadableMessage([1, 2, 5])).toBe("Pages 1, 2 and 5 could not be read.");
    const workspace = readFileSync(path.join(root, "components/reviewer-workspace.tsx"), "utf8");
    expect(workspace).toContain("unreadableMessage(entry.unreadable ?? [])");
    expect(workspace).toContain("{note.filename}: {note.message}");
  });
});
