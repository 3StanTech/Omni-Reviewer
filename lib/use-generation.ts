"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ViewsPayload } from "@/lib/serialize-view";
import type { GenerateKind, GenerationRequest } from "@/lib/generation-plan";
import { readLocalStorage, removeLocalStorage, writeLocalStorage } from "@/lib/safe-storage";

export type GenerationJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "partial";

export type SerializedGenerationJob = {
  id: string;
  status: GenerationJobStatus;
  step: GenerateKind | null;
  intent: "generate_missing" | "redo";
  targetKinds: GenerateKind[];
  completedKinds: GenerateKind[];
  percentage: number;
  progress: { completed: number; total: number; percentage: number };
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
};

export type GenerationState = {
  job: SerializedGenerationJob | null;
  jobId: string | null;
  status: GenerationJobStatus | "idle";
  step: GenerateKind | null;
  views: ViewsPayload | null;
  error: string | null;
  busy: boolean;
  dismissed: boolean;
};

type GenerationResponse = {
  jobId?: string | null;
  noOp?: boolean;
  message?: string;
  status?: GenerationJobStatus;
  step?: GenerateKind | null;
  job?: SerializedGenerationJob | null;
  views?: ViewsPayload | null;
  error?: { message?: string; retryable?: boolean } | string | null;
};

/** Return the server-authoritative job identity carried by a response. */
export function responseJobId(
  data: Pick<GenerationResponse, "jobId" | "job">,
  fallback: string,
): string {
  return data.jobId || data.job?.id || fallback;
}

const TERMINAL = new Set<GenerationJobStatus>(["succeeded", "failed", "partial"]);
const DISMISSED_PREFIX = "omni-generation-dismissed:";

function errorMessage(data: GenerationResponse, fallback: string): string {
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  if (
    data.error &&
    typeof data.error !== "string" &&
    typeof data.error.message === "string" &&
    data.error.message.trim()
  ) {
    return data.error.retryable
      ? `${data.error.message} You can retry.`
      : data.error.message;
  }
  return fallback;
}

function dismissedKey(userId: string, reviewerId: string): string {
  return `${DISMISSED_PREFIX}${userId}:${reviewerId}`;
}

export function useGeneration(args: {
  userId: string;
  reviewerId: string;
  onViews: (views: ViewsPayload) => void;
  onCardsRefresh?: () => void;
}) {
  const [state, setState] = useState<GenerationState>({
    job: null,
    jobId: null,
    status: "idle",
    step: null,
    views: null,
    error: null,
    busy: false,
    dismissed: false,
  });
  const runRef = useRef<{ jobId: string; controller: AbortController } | null>(null);
  const activeJobRef = useRef<string | null>(null);
  const startRef = useRef(false);
  const userRef = useRef(args.userId);
  const reviewerRef = useRef(args.reviewerId);
  const onViewsRef = useRef(args.onViews);
  const onCardsRefreshRef = useRef(args.onCardsRefresh);
  userRef.current = args.userId;
  reviewerRef.current = args.reviewerId;
  onViewsRef.current = args.onViews;
  onCardsRefreshRef.current = args.onCardsRefresh;

  const applyResponse = useCallback((jobId: string, data: GenerationResponse) => {
    if (reviewerRef.current !== args.reviewerId) return;
    if (activeJobRef.current !== jobId) return;
    if (responseJobId(data, jobId) !== jobId) return;
    if (data.views) {
      onViewsRef.current(data.views);
    }
    const job = data.job ?? null;
    const status = data.status ?? job?.status ?? "idle";
    setState((current) => ({
      ...current,
      job,
      jobId,
      status,
      step: data.step ?? job?.step ?? null,
      views: data.views ?? current.views,
      error: TERMINAL.has(status as GenerationJobStatus) && status !== "succeeded"
        ? errorMessage(data, "Generation stopped partway. Successful views were kept.")
        : null,
      dismissed: readLocalStorage(dismissedKey(userRef.current, args.reviewerId)) === jobId,
    }));
    if (job?.status === "succeeded" && job.completedKinds.includes("carded")) {
      onCardsRefreshRef.current?.();
    }
  }, [args.reviewerId]);

  const poll = useCallback(async (jobId: string, initial?: GenerationResponse) => {
    if (runRef.current?.jobId === jobId) return;
    const controller = new AbortController();
    runRef.current?.controller.abort();
    activeJobRef.current = jobId;
    runRef.current = { jobId, controller };
    setState((current) => ({ ...current, busy: true, error: null, jobId }));
    try {
      if (initial) {
        const initialJobId = responseJobId(initial, jobId);
        if (initialJobId !== jobId) {
          await poll(initialJobId, initial);
          return;
        }
        if (activeJobRef.current !== jobId || controller.signal.aborted) return;
        applyResponse(jobId, initial);
      }
      for (let attempt = 0; attempt < 180; attempt++) {
        if (controller.signal.aborted) return;
        const response = await fetch(
          `/api/reviewers/${args.reviewerId}/generation/${jobId}`,
          { method: "POST", signal: controller.signal },
        );
        let data: GenerationResponse | null = null;
        try {
          data = (await response.json()) as GenerationResponse;
        } catch {
          data = null;
        }
        if (!data) throw new Error("Generation returned an invalid response.");
        if (!response.ok && !data.status) {
          throw new Error(errorMessage(data, "Generation failed. Try again shortly."));
        }
        const responseId = responseJobId(data, jobId);
        if (responseId !== jobId) {
          // The old endpoint can report that another request reactivated or
          // created the winning job. Adopt that identity atomically: starting
          // the new poll aborts this controller, updates activeJobRef/state,
          // and makes every late response from the old URL inert.
          if (activeJobRef.current !== jobId || controller.signal.aborted) return;
          await poll(responseId, data);
          return;
        }
        if (activeJobRef.current !== jobId || controller.signal.aborted) return;
        applyResponse(jobId, data);
        const status = data.status ?? data.job?.status;
        if (status && TERMINAL.has(status)) return;
        await new Promise((resolve, reject) => {
          const timer = window.setTimeout(resolve, 1_500);
          controller.signal.addEventListener("abort", () => {
            window.clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
      }
      throw new Error("Generation is taking too long. Refresh and check views.");
    } catch (error) {
      if (controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Generation failed. Try again shortly.",
      }));
    } finally {
      if (runRef.current?.jobId === jobId) {
        runRef.current = null;
        setState((current) => ({ ...current, busy: false }));
      }
    }
  }, [applyResponse, args.reviewerId]);

  const start = useCallback(async (request: GenerationRequest) => {
    if (startRef.current || runRef.current) return;
    startRef.current = true;
    activeJobRef.current = null;
    setState((current) => ({
      ...current,
      job: null,
      jobId: null,
      status: "idle",
      step: null,
      views: null,
      busy: true,
      error: null,
      dismissed: false,
    }));
    removeLocalStorage(dismissedKey(userRef.current, args.reviewerId));
    try {
      const response = await fetch(`/api/reviewers/${args.reviewerId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      let data: GenerationResponse | null = null;
      try {
        data = (await response.json()) as GenerationResponse;
      } catch {
        data = null;
      }
      if (!data) throw new Error("Generation returned an invalid response.");
      if (!response.ok) throw new Error(errorMessage(data, "Generation failed. Try again shortly."));
      if (data.noOp || !data.jobId) {
        if (data.views) onViewsRef.current(data.views);
        setState((current) => ({
          ...current,
          job: null,
          jobId: null,
          status: "idle",
          step: null,
          views: data?.views ?? current.views,
          error: null,
          busy: false,
        }));
        return;
      }
      await poll(data.jobId, data);
    } catch (error) {
      setState((current) => ({
        ...current,
        job: null,
        jobId: null,
        status: "failed",
        step: null,
        busy: false,
        error: error instanceof Error ? error.message : "Generation failed. Try again shortly.",
      }));
    } finally {
      startRef.current = false;
    }
  }, [args.reviewerId, poll]);

  const dismiss = useCallback(() => {
    if (typeof window === "undefined") return;
    if (state.jobId) writeLocalStorage(dismissedKey(userRef.current, args.reviewerId), state.jobId);
    setState((current) => ({
      ...current,
      status: current.jobId ? current.status : "idle",
      error: null,
      dismissed: true,
    }));
  }, [args.reviewerId, state.jobId]);

  const resume = useCallback((jobId = state.jobId) => {
    return jobId ? poll(jobId) : Promise.resolve();
  }, [poll, state.jobId]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/reviewers/${args.reviewerId}/generation`)
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as GenerationResponse;
      })
      .then((data) => {
        const jobId = data?.jobId ?? data?.job?.id;
        if (cancelled || !jobId || !data) return;
        activeJobRef.current = jobId;
        applyResponse(jobId, data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      runRef.current?.controller.abort();
      runRef.current = null;
      activeJobRef.current = null;
    };
  }, [applyResponse, args.reviewerId]);

  return {
    state,
    start,
    resume,
    dismiss,
  };
}
