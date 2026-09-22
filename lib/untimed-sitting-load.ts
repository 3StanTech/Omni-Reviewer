import { readApiError } from "@/lib/utils";
import type { PracticeAnswer } from "@/lib/practice-session";

export type UntimedSittingPayload = {
  sessionId: string;
  viewRevision: number;
  status: "active" | "completed" | "expired";
  itemIds: string[];
  originSessionId: string | null;
  answers: PracticeAnswer[];
  nextItemId: string | null;
  nextIndex: number;
  complete: boolean;
  correctCount: number;
  canRetryMissed: boolean;
};

export type UntimedSittingLoadResult =
  | UntimedSittingPayload
  | { error: string; aborted?: boolean };

export type UntimedSittingLoad = {
  key: string;
  promise: Promise<UntimedSittingLoadResult>;
  signal: AbortSignal;
  abort: () => void;
};

export function sittingLoadKey(reviewerId: string, viewRevision: number): string {
  return `${reviewerId}:${viewRevision}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError")
    || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
  );
}

export async function fetchUntimedSitting(
  reviewerId: string,
  viewRevision: number,
  signal?: AbortSignal,
): Promise<UntimedSittingLoadResult> {
  try {
    if (signal?.aborted) return { error: "aborted", aborted: true };
    const lookup = await fetch(
      `/api/reviewers/${reviewerId}/practice-session?expectedRevision=${viewRevision}`,
      { signal },
    );
    if (!lookup.ok) throw new Error(await readApiError(lookup));
    const existing = (await lookup.json()) as UntimedSittingPayload | { session: null };
    if ("sessionId" in existing) return existing;
    const created = await fetch(`/api/reviewers/${reviewerId}/practice-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: viewRevision, intent: "start" }),
      signal,
    });
    if (!created.ok) throw new Error(await readApiError(created));
    return (await created.json()) as UntimedSittingPayload;
  } catch (caught) {
    if (signal?.aborted || isAbortError(caught)) return { error: "aborted", aborted: true };
    return { error: caught instanceof Error ? caught.message : "Could not open this sitting." };
  }
}

export function startUntimedSittingLoad(
  reviewerId: string,
  viewRevision: number,
  load: typeof fetchUntimedSitting = fetchUntimedSitting,
): UntimedSittingLoad {
  const controller = new AbortController();
  return {
    key: sittingLoadKey(reviewerId, viewRevision),
    promise: load(reviewerId, viewRevision, controller.signal),
    signal: controller.signal,
    abort: () => controller.abort(),
  };
}

/**
 * Reuse an in-flight load for the same reviewer and revision. An aborted load
 * is not reusable: React StrictMode's effect cleanup can abort it without
 * discarding the component state that cached the promise.
 */
export function sittingLoadForIdentity(
  current: UntimedSittingLoad | null,
  reviewerId: string,
  viewRevision: number,
  load: typeof fetchUntimedSitting = fetchUntimedSitting,
): UntimedSittingLoad {
  const key = sittingLoadKey(reviewerId, viewRevision);
  if (current?.key === key && !current.signal.aborted) return current;
  if (current && current.key !== key) current.abort();
  return startUntimedSittingLoad(reviewerId, viewRevision, load);
}
