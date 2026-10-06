"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { uploadSourceFile } from "@/lib/batch-upload";
import type { GenerateKind } from "@/lib/generation-plan";
import {
  canStartPack,
  isBatchFile,
  nextRunnable,
  packNameFromFilename,
  queueRowState,
  type QueuedPackItem,
  type QueueRowState,
} from "@/lib/generation-queue";
import {
  responseJobId,
  type GenerationJobStatus,
  type SerializedGenerationJob,
} from "@/lib/use-generation";
import { readApiError } from "@/lib/utils";

export type QueueRow = {
  key: string;
  reviewerId: string | null;
  topicId: string;
  name: string;
  state: QueueRowState;
  message: string | null;
};

export type QueueQuota = { remaining: number | null; limit: number | null };

type UploadRow = {
  key: string;
  reviewerId: string | null;
  topicId: string;
  name: string;
  state: "uploading" | "reading" | "unreadable";
  message: string | null;
};

type StepResponse = {
  jobId?: string | null;
  noOp?: boolean;
  status?: GenerationJobStatus;
  step?: GenerateKind | null;
  job?: SerializedGenerationJob | null;
  error?: { message?: string } | string | null;
};

const TERMINAL = new Set<GenerationJobStatus>(["succeeded", "failed", "partial"]);
const POLL_MS = 1_500;
const MAX_POLLS = 180;

function stepError(data: StepResponse | null, fallback: string): string {
  if (typeof data?.error === "string" && data.error.trim()) return data.error;
  if (data?.error && typeof data.error !== "string" && data.error.message?.trim()) {
    return data.error.message;
  }
  return fallback;
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

async function putQueued(
  reviewerId: string,
  queued: boolean,
  signal?: AbortSignal,
  requeue = false,
) {
  const response = await fetch(`/api/reviewers/${reviewerId}/queue`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requeue ? { queued, requeue } : { queued }),
    signal,
  });
  if (!response.ok) throw new Error(await readApiError(response));
}

/**
 * The Study desk's generation queue. Only packs the student queued run, one
 * at a time, and only while the desk is open with a full pack's worth of free
 * requests left. Unmounting aborts the run; the next visit picks it up again.
 */
export function useGenerationQueue({ userId }: { userId: string | null }) {
  const router = useRouter();
  const [packs, setPacks] = useState<QueuedPackItem[]>([]);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [failed, setFailed] = useState<Map<string, QueuedPackItem & { message: string }>>(new Map());
  const [running, setRunning] = useState<{ id: string; step: GenerateKind | null } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [quota, setQuota] = useState<QueueQuota | null>(null);
  const [uploading, setUploading] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const loopRef = useRef(false);
  const dirtyRef = useRef(false);
  const waitingRef = useRef(false);
  const failedRef = useRef<Set<string>>(new Set());

  const loadQueue = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/queue", { cache: "no-store", signal });
    if (!response.ok) throw new Error(await readApiError(response));
    const data = await readJson<{ packs?: QueuedPackItem[] }>(response);
    const list = data?.packs ?? [];
    setPacks(list);
    return list;
  }, []);

  const markFailed = useCallback((pack: QueuedPackItem, message: string) => {
    failedRef.current.add(pack.id);
    setFailed((current) => new Map(current).set(pack.id, { ...pack, message }));
  }, []);

  /**
   * Drive one pack to a terminal state. Returns false when aborted. The pack
   * stays queued server-side while it runs (`?queue=1`); success dequeues it,
   * and a failed or partial run lists as failed until Retry.
   */
  const runPack = useCallback(async (pack: QueuedPackItem, signal: AbortSignal) => {
    setRunning({ id: pack.id, step: null });
    let jobId = pack.activeJobId;
    try {
      if (!jobId) {
        const response = await fetch(`/api/reviewers/${pack.id}/generate?queue=1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intent: "generate_missing" }),
          signal,
        });
        const data = await readJson<StepResponse>(response);
        if (!response.ok || !data) {
          throw new Error(stepError(data, "Generation failed. Try again shortly."));
        }
        if (data.noOp || !data.jobId) {
          await putQueued(pack.id, false, signal);
          return true;
        }
        jobId = responseJobId(data, data.jobId);
        setRunning({ id: pack.id, step: data.step ?? data.job?.step ?? null });
      }
      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        const response = await fetch(`/api/reviewers/${pack.id}/generation/${jobId}`, {
          method: "POST",
          signal,
        });
        const data = await readJson<StepResponse>(response);
        if (!data) throw new Error("Generation returned an invalid response.");
        if (!response.ok && !data.status) {
          throw new Error(stepError(data, "Generation failed. Try again shortly."));
        }
        // Another request may have reactivated or created the winning job.
        jobId = responseJobId(data, jobId);
        setRunning({ id: pack.id, step: data.step ?? data.job?.step ?? null });
        const status = data.status ?? data.job?.status;
        if (status === "succeeded") {
          await putQueued(pack.id, false, signal);
          return true;
        }
        // Failed or partial stays queued and lists as failed: Retry is explicit.
        if (status && TERMINAL.has(status)) return true;
        await wait(POLL_MS, signal);
      }
      throw new Error("Generation is taking too long. Open the pack to check it.");
    } catch (caught) {
      if (signal.aborted) return false;
      markFailed(pack, caught instanceof Error ? caught.message : "Generation failed. Try again shortly.");
      // Without a job nothing resumes it, so drop it from the queue; a job
      // that stalled stays queued and the next visit adopts it.
      if (!jobId) await putQueued(pack.id, false).catch(() => undefined);
      return true;
    } finally {
      setRunning(null);
    }
  }, [markFailed]);

  /**
   * Run queued packs until none is runnable, quota runs short, the tab is
   * hidden, or the desk unmounts. A kick during a run marks the queue dirty;
   * the loop then re-reads it, including after a remount (Strict Mode).
   */
  const kick = useCallback(async () => {
    if (loopRef.current || waitingRef.current || !controllerRef.current) {
      dirtyRef.current = true;
      return;
    }
    loopRef.current = true;
    try {
      let controller: AbortController | null = controllerRef.current;
      while (controller && !controller.signal.aborted) {
        const { signal } = controller;
        dirtyRef.current = false;
        try {
          const list = await loadQueue(signal);
          const next = nextRunnable(list, failedRef.current);
          if (!next) {
            if (dirtyRef.current) continue;
            break;
          }
          // A hidden tab never starts the next pack; visibilitychange kicks again.
          if (document.visibilityState !== "visible") break;
          const quotaResponse = await fetch("/api/quota?fresh=1", { cache: "no-store", signal });
          const nextQuota = quotaResponse.ok
            ? await readJson<QueueQuota>(quotaResponse)
            : null;
          setQuota(nextQuota);
          if (!canStartPack(nextQuota?.remaining)) {
            waitingRef.current = true;
            setWaiting(true);
            break;
          }
          if (await runPack(next, signal)) router.refresh();
          setError(null);
        } catch (caught) {
          if (!signal.aborted) {
            setError(caught instanceof Error ? caught.message : "Could not load the queue.");
            break;
          }
        }
        // An aborted run hands over to the desk's current mount, if any.
        if (signal.aborted) {
          controller = dirtyRef.current && !waitingRef.current ? controllerRef.current : null;
        }
      }
    } finally {
      loopRef.current = false;
    }
  }, [loadQueue, router, runPack]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    waitingRef.current = false;
    void kick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void kick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [kick]);

  const enqueueFiles = useCallback(async (files: File[], topicId: string) => {
    if (!userId || files.length === 0) return;
    const accepted = files.filter(isBatchFile);
    setSkipped(files.filter((file) => !isBatchFile(file)).map((file) => file.name));
    setUploading(true);
    const patch = (key: string, values: Partial<UploadRow>) => {
      setUploads((current) => current.map((row) => (row.key === key ? { ...row, ...values } : row)));
    };
    try {
      for (const file of accepted) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const name = packNameFromFilename(file.name);
        setUploads((current) => [
          ...current,
          { key, reviewerId: null, topicId, name, state: "uploading", message: null },
        ]);
        try {
          const created = await fetch("/api/reviewers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topicId, name }),
          });
          if (!created.ok) throw new Error(await readApiError(created));
          const { id: reviewerId } = (await created.json()) as { id: string };
          patch(key, { reviewerId });
          const source = await uploadSourceFile({
            userId,
            reviewerId,
            file,
            // Ingest runs inside the register request once the bytes land.
            onProgress: (percentage) => {
              if (percentage >= 100) patch(key, { state: "reading" });
            },
          });
          if (source.ingestStatus !== "ready") {
            patch(key, { state: "unreadable", message: source.errorMessage });
            continue;
          }
          // Queue only packs with text to study: a scanned PDF is "ready"
          // before its pages are read, which happens in the pack itself.
          await putQueued(reviewerId, true);
          const queued = (await loadQueue()).find((pack) => pack.id === reviewerId);
          if (!queued?.ready) {
            await putQueued(reviewerId, false);
            await loadQueue();
            patch(key, { state: "unreadable", message: null });
            continue;
          }
          setUploads((current) => current.filter((row) => row.key !== key));
          void kick();
        } catch (caught) {
          patch(key, {
            state: "unreadable",
            message: caught instanceof Error ? caught.message : null,
          });
        }
      }
    } finally {
      setUploading(false);
      router.refresh();
      void kick();
    }
  }, [kick, loadQueue, router, userId]);

  const remove = useCallback(async (reviewerId: string) => {
    setUploads((current) => current.filter((row) => row.reviewerId !== reviewerId));
    failedRef.current.delete(reviewerId);
    setFailed((current) => {
      const next = new Map(current);
      next.delete(reviewerId);
      return next;
    });
    try {
      await putQueued(reviewerId, false);
      await loadQueue();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the queue.");
    }
  }, [loadQueue]);

  const retry = useCallback(async (reviewerId: string) => {
    failedRef.current.delete(reviewerId);
    setFailed((current) => {
      const next = new Map(current);
      next.delete(reviewerId);
      return next;
    });
    try {
      await putQueued(reviewerId, true, undefined, true);
      void kick();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the queue.");
    }
  }, [kick]);

  /** Re-read the free requests after a wait; never on a timer. */
  const checkAgain = useCallback(() => {
    waitingRef.current = false;
    setWaiting(false);
    void kick();
  }, [kick]);

  const rows = useMemo<QueueRow[]>(() => {
    const runner = {
      runningId: running?.id ?? null,
      step: running?.step ?? null,
      waiting,
      failedIds: new Set(failed.keys()),
    };
    const queued = packs
      .filter((pack) => !failed.has(pack.id))
      .map((pack) => ({
        key: pack.id,
        reviewerId: pack.id,
        topicId: pack.topicId,
        name: pack.name,
        state: queueRowState(pack, runner),
        message: pack.failed ? pack.lastError : null,
      }));
    const failedRows = [...failed.values()].map((pack) => ({
      key: pack.id,
      reviewerId: pack.id,
      topicId: pack.topicId,
      name: pack.name,
      state: { kind: "failed" } as const,
      message: pack.message,
    }));
    const uploadRows = uploads.map((row) => ({
      key: row.key,
      reviewerId: row.reviewerId,
      topicId: row.topicId,
      name: row.name,
      state: { kind: row.state } as QueueRowState,
      message: row.message,
    }));
    return [...queued, ...failedRows, ...uploadRows];
  }, [failed, packs, running, uploads, waiting]);

  return {
    rows,
    enqueueFiles,
    remove,
    retry,
    checkAgain,
    status: { uploading, running: running !== null, waiting, quota, skipped, error },
  };
}
