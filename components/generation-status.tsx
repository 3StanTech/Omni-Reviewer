"use client";

import { X } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import type { GenerationState } from "@/lib/use-generation";

const STEP_LABELS: Record<string, string> = {
  locked_in: "Locked In",
  summary: "Summary",
  test_me: "Test Me",
  carded: "Carded",
};

export function GenerationStatus({
  state,
  onDismiss,
  onResume,
}: {
  state: GenerationState;
  onDismiss: () => void;
  onResume: () => void;
}) {
  if (state.status === "idle" || state.dismissed) return null;
  const percentage = state.job?.percentage ?? (state.status === "succeeded" ? 100 : 0);
  const terminal = state.status === "succeeded" || state.status === "failed" || state.status === "partial";
  const title = state.status === "succeeded"
    ? "Finished"
    : state.status === "partial"
      ? "Generation stopped partway"
      : state.status === "failed"
        ? "Generation failed"
        : state.busy
          ? "Generating"
          : "Generation ready to resume";
  return (
    <section
      className="rounded-lg border border-border bg-surface/50 p-3 text-sm"
      aria-labelledby="generation-status-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 id="generation-status-heading" className="font-medium text-foreground">
            {title}
          </h3>
          <div
            className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
            aria-label="Generation progress"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${percentage}%` }} />
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {percentage}%{state.step ? ` · ${STEP_LABELS[state.step] ?? state.step}` : ""}
            {state.job ? ` · ${state.job.progress.completed}/${state.job.progress.total} steps saved` : ""}
          </p>
          {state.error ? <p role="alert" className="text-xs text-destructive">{state.error}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {((!terminal && !state.busy) || state.status === "failed" || state.status === "partial") && state.jobId ? (
            <Button type="button" variant="outline" size="xs" onClick={onResume}>Resume</Button>
          ) : null}
          {terminal ? (
            <Button type="button" variant="ghost" size="icon-xs" onClick={onDismiss} aria-label="Dismiss generation status">
              <X weight="bold" />
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
