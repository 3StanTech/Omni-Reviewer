"use client";

/**
 * Reads the slide pictures of ready PDF sources in the browser: pages with
 * little text are rendered to JPEGs here and sent in small batches to the
 * pages route, which asks the model and merges the readings into the text.
 *
 * The scheduling rules live in `VisionRunner` and the pure helpers below so
 * tests can drive them with fakes, without React or a DOM.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Pages per POST. Mirrors `MAX_VISION_BATCH_PAGES` on the server. */
export const VISION_BATCH_PAGES = 8;
/** POSTs in flight across every source. */
export const VISION_CONCURRENCY = 2;
/** Mirrors `MAX_VISION_BATCH_BYTES` on the server. */
export const VISION_BATCH_BYTES = 4 * 1024 * 1024;

export const VISION_QUOTA_MESSAGE =
  "The free reading limit is reached for now. Reading picks up the next time you open this pack.";
export const VISION_FAILED_MESSAGE = "Could not read some slides.";
/** The pages route's 409 body when the text changed under a merge. */
export const VISION_SOURCE_CHANGED = "This source changed while reading. Try again.";

export type VisionProgress = {
  state: "reading" | "done" | "stopped";
  done: number;
  total: number;
  message?: string;
};

export type VisionSource = {
  id: string;
  kind: string;
  ingestStatus: string;
  blobPathname: string | null;
};

/** One POST's worth of pages. `images` is kept when a batch is retried or split. */
export type VisionTask = {
  sourceId: string;
  pages: number[];
  final: boolean;
  attempt: number;
  images?: Blob[];
  /** Which pending list the task came from; a re-GET makes older tasks stale. */
  epoch?: number;
};

export type BatchOutcome =
  | { kind: "ok"; read: number[]; missing: number[]; pending: number[] }
  | { kind: "quota" }
  | { kind: "changed" }
  | { kind: "gone" }
  | { kind: "failed" };

export function isVisionEligible(source: VisionSource): boolean {
  return source.kind === "pdf" && source.ingestStatus === "ready" && Boolean(source.blobPathname);
}

/** Split pages into POST-sized batches, keeping their order. */
export function chunkPages(pages: readonly number[], size = VISION_BATCH_PAGES): number[][] {
  const batches: number[][] = [];
  for (let index = 0; index < pages.length; index += size) {
    batches.push(pages.slice(index, index + size));
  }
  return batches;
}

/** Whether another POST may start while `inFlight` are running. */
export function canStartPost(inFlight: number, concurrency = VISION_CONCURRENCY): boolean {
  return inFlight < concurrency;
}

/**
 * Group rendered images, in order, so each group stays under the batch byte
 * cap. Eight images at the per-image cap would exceed it.
 */
export function splitBySize(sizes: readonly number[], maxBytes = VISION_BATCH_BYTES): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  sizes.forEach((size, index) => {
    if (current.length > 0 && bytes + size > maxBytes) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(index);
    bytes += size;
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

function numberList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => Number.isInteger(entry)) : [];
}

/** Classify a pages POST response. `status` 0 means the request never completed. */
export function classifyBatchResponse(status: number, body: unknown): BatchOutcome {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status >= 200 && status < 300) {
    return {
      kind: "ok",
      read: numberList(record.read),
      missing: numberList(record.missing),
      pending: numberList(record.pending),
    };
  }
  if (status === 429) return { kind: "quota" };
  if (status === 409) return record.error === VISION_SOURCE_CHANGED ? { kind: "changed" } : { kind: "gone" };
  if (status === 404) return { kind: "gone" };
  return { kind: "failed" };
}

/** Missing pages are re-sent once, marked final so the server settles them. */
export function missingFollowUp(task: VisionTask, missing: readonly number[]): VisionTask | null {
  if (task.final || missing.length === 0) return null;
  return { sourceId: task.sourceId, pages: [...missing], final: true, attempt: 0, epoch: task.epoch };
}

export type FailureDecision =
  | { kind: "split"; halves: [VisionTask, VisionTask] }
  | { kind: "retry"; task: VisionTask }
  | { kind: "give_up" };

/**
 * What to do after a batch fails for a reason other than quota or a changed
 * source. Resending the same pages rarely helps (one bad image can fail the
 * whole batch), so a batch is halved instead, down to single pages. A page
 * reached by halving has already failed once, so it is not retried again;
 * only a page sent alone from the start gets one more try. Eight pages cost
 * at most 15 posts. Giving up on a page does not stop the rest of its source.
 */
export function failureDecision(task: VisionTask): FailureDecision {
  if (task.pages.length > 1) {
    const cut = Math.ceil(task.pages.length / 2);
    const half = (from: number, to: number): VisionTask => ({
      ...task,
      pages: task.pages.slice(from, to),
      images: task.images?.slice(from, to),
      attempt: 1,
    });
    return { kind: "split", halves: [half(0, cut), half(cut, task.pages.length)] };
  }
  if (task.attempt < 1) return { kind: "retry", task: { ...task, attempt: task.attempt + 1 } };
  return { kind: "give_up" };
}

/** A source changed under a merge re-reads its pending list once, then stops. */
export function changedDecision(alreadyRefetched: boolean): "refetch" | "stop" {
  return alreadyRefetched ? "stop" : "refetch";
}

/** Progress follows the server's pending count, never the pages sent. */
export function progressFor(total: number, pending: readonly number[]): { done: number; total: number } {
  const nextTotal = Math.max(total, pending.length);
  return { done: nextTotal - pending.length, total: nextTotal };
}

export type VisionDeps = {
  /** GET the pending pages. Returns null when the source cannot be read (not a ready PDF, or gone). */
  getPending(sourceId: string, signal: AbortSignal): Promise<number[] | null>;
  loadBytes(sourceId: string, signal: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  render(
    bytes: ArrayBuffer | Uint8Array,
    pages: number[],
    signal: AbortSignal,
  ): AsyncIterable<{ page: number; blob: Blob }>;
  post(
    sourceId: string,
    batch: { pages: number[]; images: Blob[]; final: boolean },
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
  onProgress(sourceId: string, progress: VisionProgress | null): void;
  onTextChanged(sourceId: string): void;
};

type Job = {
  total: number;
  pending: number[];
  bytes: Promise<ArrayBuffer | Uint8Array> | null;
  refetched: boolean;
  requeued: boolean;
  epoch: number;
  wrote: boolean;
  /** A page was given up on; the source stops once its other batches finish. */
  failed: boolean;
  /** Tasks queued or running for this source. */
  open: number;
  state: VisionProgress["state"];
};

/**
 * Schedules reading across sources. At most `VISION_CONCURRENCY` runners,
 * each posting one batch while it renders the next, so POSTs never exceed the
 * cap. One AbortController stops everything.
 */
export class VisionRunner {
  private readonly controller = new AbortController();
  private readonly jobs = new Map<string, Job>();
  private readonly checked = new Set<string>();
  private queue: VisionTask[] = [];
  private runners = 0;
  private inFlight = 0;
  private halted = false;
  /** Highest POST concurrency seen; for tests. */
  maxInFlight = 0;

  constructor(private readonly deps: VisionDeps) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(): void {
    this.controller.abort();
    this.queue = [];
  }

  /** Check each eligible source once; forget jobs whose source is gone. */
  sync(sources: readonly VisionSource[]): Promise<void> {
    const ids = new Set(sources.map((source) => source.id));
    for (const id of [...this.jobs.keys()]) {
      if (!ids.has(id)) this.drop(id);
    }
    const checks = sources
      .filter((source) => isVisionEligible(source) && !this.checked.has(source.id))
      .map((source) => this.check(source.id));
    return Promise.all(checks).then(() => undefined);
  }

  /** Start over on one source, and lift a quota stop. */
  retry(sourceId: string): Promise<void> {
    this.halted = false;
    this.drop(sourceId);
    this.checked.delete(sourceId);
    return this.check(sourceId);
  }

  /** Resolves when no runner is left. For tests. */
  async idle(): Promise<void> {
    while (this.runners > 0 || this.pendingChecks > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private pendingChecks = 0;

  private async check(sourceId: string): Promise<void> {
    if (this.checked.has(sourceId) || this.signal.aborted) return;
    this.checked.add(sourceId);
    this.pendingChecks += 1;
    try {
      let pending: number[] | null;
      try {
        pending = await this.deps.getPending(sourceId, this.signal);
      } catch {
        if (this.signal.aborted) return;
        this.stop(sourceId, VISION_FAILED_MESSAGE, { done: 0, total: 0 });
        return;
      }
      if (this.signal.aborted || pending === null || pending.length === 0) return;
      if (this.halted) {
        this.stop(sourceId, VISION_QUOTA_MESSAGE, { done: 0, total: pending.length });
        return;
      }
      const job: Job = {
        total: pending.length,
        pending,
        bytes: null,
        refetched: false,
        requeued: false,
        epoch: 0,
        wrote: false,
        failed: false,
        open: 0,
        state: "reading",
      };
      this.jobs.set(sourceId, job);
      this.report(sourceId, job);
      this.enqueue(sourceId, pending);
      this.pump();
    } finally {
      this.pendingChecks -= 1;
    }
  }

  private enqueue(sourceId: string, pages: readonly number[], front = false): void {
    const job = this.jobs.get(sourceId);
    if (!job) return;
    const tasks = chunkPages(pages).map((batch): VisionTask => ({
      sourceId,
      pages: batch,
      final: false,
      attempt: 0,
      epoch: job.epoch,
    }));
    job.open += tasks.length;
    this.queue = front ? [...tasks, ...this.queue] : [...this.queue, ...tasks];
  }

  private pushFront(task: VisionTask): void {
    const job = this.jobs.get(task.sourceId);
    if (!job) return;
    job.open += 1;
    this.queue.unshift(task);
  }

  private pump(): void {
    while (!this.halted && !this.signal.aborted && this.runners < VISION_CONCURRENCY && this.queue.length > 0) {
      this.runners += 1;
      void this.run().finally(() => {
        this.runners -= 1;
        // A task may have been queued while this runner was leaving.
        this.pump();
      });
    }
  }

  /** Take the next task whose source is still reading. */
  private claim(): VisionTask | null {
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      const job = this.jobs.get(task.sourceId);
      if (job?.state === "reading") return task;
    }
    return null;
  }

  private async run(): Promise<void> {
    let current = this.claim();
    let rendered = current ? this.render(current) : null;
    while (current && rendered && !this.signal.aborted) {
      const images = await rendered;
      // Render the next batch while this one posts.
      const next = this.halted || this.signal.aborted ? null : this.claim();
      const nextRendered = next ? this.render(next) : null;
      if (images) await this.send(current, images);
      else this.fail(current);
      this.close(current.sourceId);
      if (this.halted || this.signal.aborted) {
        if (next) this.close(next.sourceId);
        return;
      }
      current = next;
      rendered = nextRendered;
    }
  }

  /** Rendered images for a task, or null when rendering failed. Never rejects. */
  private async render(task: VisionTask): Promise<Blob[] | null> {
    if (task.images) return task.images;
    const job = this.jobs.get(task.sourceId);
    if (!job) return null;
    try {
      job.bytes ??= this.deps.loadBytes(task.sourceId, this.signal);
      const bytes = await job.bytes;
      const byPage = new Map<number, Blob>();
      for await (const entry of this.deps.render(bytes, task.pages, this.signal)) {
        byPage.set(entry.page, entry.blob);
      }
      if (this.signal.aborted) return null;
      return task.pages.map((page) => {
        const blob = byPage.get(page);
        if (!blob) throw new Error(`Page ${page} did not render.`);
        return blob;
      });
    } catch {
      // A failed download is not cached, so a retry fetches again.
      job.bytes = null;
      return null;
    }
  }

  private async send(task: VisionTask, images: Blob[]): Promise<void> {
    const job = this.jobs.get(task.sourceId);
    if (!job || job.state !== "reading" || (task.epoch ?? 0) !== job.epoch) return;

    const groups = splitBySize(images.map((image) => image.size));
    if (groups.length > 1) {
      // Keep the first group here; the rest wait at the front, already rendered.
      for (const group of groups.slice(1).reverse()) {
        this.pushFront({
          ...task,
          pages: group.map((index) => task.pages[index]!),
          images: group.map((index) => images[index]!),
        });
      }
      task = {
        ...task,
        pages: groups[0]!.map((index) => task.pages[index]!),
        images: groups[0]!.map((index) => images[index]!),
      };
      images = task.images!;
    }

    let outcome: BatchOutcome;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const response = await this.deps.post(
        task.sourceId,
        { pages: task.pages, images, final: task.final },
        this.signal,
      );
      outcome = classifyBatchResponse(response.status, response.body);
    } catch {
      outcome = { kind: "failed" };
    } finally {
      this.inFlight -= 1;
    }
    if (this.signal.aborted || job.state !== "reading") return;

    switch (outcome.kind) {
      case "ok": {
        job.pending = outcome.pending;
        if (outcome.read.length > 0) job.wrote = true;
        const follow = missingFollowUp(task, outcome.missing);
        if (follow) this.pushFront(follow);
        this.report(task.sourceId, job);
        return;
      }
      case "quota":
        this.haltAll();
        return;
      case "changed":
        await this.refetch(task.sourceId, job);
        return;
      case "gone":
        this.drop(task.sourceId);
        return;
      case "failed":
        this.fail({ ...task, images });
        return;
    }
  }

  private fail(task: VisionTask): void {
    const job = this.jobs.get(task.sourceId);
    if (!job || job.state !== "reading" || (task.epoch ?? 0) !== job.epoch) return;
    const decision = failureDecision(task);
    if (decision.kind === "split") {
      this.pushFront(decision.halves[1]);
      this.pushFront(decision.halves[0]);
    } else if (decision.kind === "retry") {
      this.pushFront(decision.task);
    } else {
      job.failed = true;
    }
  }

  private async refetch(sourceId: string, job: Job): Promise<void> {
    if (changedDecision(job.refetched) === "stop") {
      this.stop(sourceId, VISION_FAILED_MESSAGE, progressFor(job.total, job.pending));
      return;
    }
    job.refetched = true;
    job.epoch += 1;
    this.removeQueued(sourceId);
    let pending: number[] | null;
    try {
      pending = await this.deps.getPending(sourceId, this.signal);
    } catch {
      if (!this.signal.aborted) this.stop(sourceId, VISION_FAILED_MESSAGE, progressFor(job.total, job.pending));
      return;
    }
    if (this.signal.aborted || job.state !== "reading") return;
    if (pending === null) {
      this.drop(sourceId);
      return;
    }
    job.pending = pending;
    this.report(sourceId, job);
    this.enqueue(sourceId, pending, true);
  }

  /** A task left the queue. When a source has none left, settle it. */
  private close(sourceId: string): void {
    const job = this.jobs.get(sourceId);
    if (!job) return;
    job.open -= 1;
    if (job.open > 0 || job.state !== "reading") return;
    if (job.pending.length > 0 && !job.failed && !job.requeued && !this.halted && !this.signal.aborted) {
      // The server still lists pages this pass did not settle: one more pass.
      job.requeued = true;
      this.enqueue(sourceId, job.pending, true);
      return;
    }
    if (this.halted || this.signal.aborted) return;
    if (job.failed || job.pending.length > 0) {
      this.stop(sourceId, VISION_FAILED_MESSAGE, progressFor(job.total, job.pending));
      return;
    }
    job.state = "done";
    job.bytes = null;
    this.report(sourceId, job);
    if (job.wrote) this.deps.onTextChanged(sourceId);
  }

  private removeQueued(sourceId: string): void {
    const job = this.jobs.get(sourceId);
    const kept = this.queue.filter((task) => task.sourceId !== sourceId);
    if (job) job.open -= this.queue.length - kept.length;
    this.queue = kept;
  }

  private stop(sourceId: string, message: string, counts: { done: number; total: number }): void {
    const job = this.jobs.get(sourceId);
    if (job) {
      job.state = "stopped";
      job.bytes = null;
      this.removeQueued(sourceId);
    }
    this.deps.onProgress(sourceId, { state: "stopped", ...counts, message });
    if (job?.wrote) this.deps.onTextChanged(sourceId);
  }

  private haltAll(): void {
    this.halted = true;
    for (const [sourceId, job] of this.jobs) {
      if (job.state === "reading") {
        this.stop(sourceId, VISION_QUOTA_MESSAGE, progressFor(job.total, job.pending));
      }
    }
    this.queue = [];
  }

  private drop(sourceId: string): void {
    this.removeQueued(sourceId);
    const job = this.jobs.get(sourceId);
    if (job) job.state = "stopped";
    this.jobs.delete(sourceId);
    this.deps.onProgress(sourceId, null);
  }

  private report(sourceId: string, job: Job): void {
    const counts = progressFor(job.total, job.pending);
    job.total = counts.total;
    this.deps.onProgress(sourceId, { state: job.state, ...counts });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function browserDeps(
  reviewerId: string,
  files: Map<string, File>,
  handlers: Pick<VisionDeps, "onProgress" | "onTextChanged">,
): VisionDeps {
  const base = `/api/reviewers/${reviewerId}/sources`;
  return {
    async getPending(sourceId, signal) {
      const response = await fetch(`${base}/${sourceId}/pages`, { signal, cache: "no-store" });
      if (response.status === 404 || response.status === 409) return null;
      if (!response.ok) throw new Error(`Pending pages failed with ${response.status}`);
      const body = (await readJson(response)) as { pending?: unknown } | null;
      return numberList(body?.pending);
    },
    async loadBytes(sourceId, signal) {
      // A file uploaded in this tab is read from memory, not downloaded again.
      const file = files.get(sourceId);
      if (file) return file.arrayBuffer();
      const response = await fetch(`${base}/${sourceId}`, { signal });
      if (!response.ok) throw new Error(`Source download failed with ${response.status}`);
      return response.arrayBuffer();
    },
    async *render(bytes, pages, signal) {
      const { renderPdfPages } = await import("@/lib/pdf-page-images");
      yield* renderPdfPages(bytes, pages, signal);
    },
    async post(sourceId, batch, signal) {
      const form = new FormData();
      batch.pages.forEach((page, index) => {
        form.append("page", String(page));
        form.append("image", batch.images[index]!, `page-${page}.jpg`);
      });
      if (batch.final) form.append("final", "1");
      const response = await fetch(`${base}/${sourceId}/pages`, { method: "POST", body: form, signal });
      return { status: response.status, body: await readJson(response) };
    },
    ...handlers,
  };
}

export function useSourceVision({
  reviewerId,
  sources,
  onSourceTextChanged,
}: {
  reviewerId: string;
  sources: readonly VisionSource[];
  onSourceTextChanged?: (sourceId: string) => void;
}) {
  const [progress, setProgress] = useState<Record<string, VisionProgress>>({});
  const runnerRef = useRef<VisionRunner | null>(null);
  const filesRef = useRef(new Map<string, File>());
  const textChangedRef = useRef(onSourceTextChanged);
  const sourcesRef = useRef(sources);

  useEffect(() => {
    textChangedRef.current = onSourceTextChanged;
    sourcesRef.current = sources;
  });

  useEffect(() => {
    const files = filesRef.current;
    const runner = new VisionRunner(
      browserDeps(reviewerId, files, {
        onProgress(sourceId, next) {
          if (next?.state !== "reading") files.delete(sourceId);
          setProgress((current) => {
            const copy = { ...current };
            if (next) copy[sourceId] = next;
            else delete copy[sourceId];
            return copy;
          });
        },
        onTextChanged(sourceId) {
          textChangedRef.current?.(sourceId);
        },
      }),
    );
    runnerRef.current = runner;
    void runner.sync(sourcesRef.current);
    return () => {
      runner.dispose();
      if (runnerRef.current === runner) runnerRef.current = null;
    };
  }, [reviewerId]);

  useEffect(() => {
    void runnerRef.current?.sync(sources);
  }, [sources]);

  /** Keep a freshly uploaded PDF's bytes so reading does not download it again. */
  const register = useCallback((sourceId: string, file?: File) => {
    if (file) filesRef.current.set(sourceId, file);
  }, []);

  const retry = useCallback((sourceId: string) => {
    void runnerRef.current?.retry(sourceId);
  }, []);

  const reading = Object.values(progress).some((entry) => entry.state === "reading");
  return { progress, reading, register, retry };
}

export type SourceVision = ReturnType<typeof useSourceVision>;
