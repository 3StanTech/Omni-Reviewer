"use client";

import { CircleNotch, Sparkle } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import type { GenerationState } from "@/lib/use-generation";
import { cn } from "@/lib/utils";

/** Free OpenRouter requests left today on the shared key. A full pack costs about 10 to 14. */
export type FreeRequestQuota = { remaining: number; limit: number };
/** Below this, a full pack may not fit in what is left today. */
export const LOW_QUOTA_THRESHOLD = 14;

export function GenerationControls({
  state,
  hasReadySource,
  hasViews,
  hasCompleteViews,
  sourcesAreMediaOnly,
  busyReason = null,
  quota,
  onGenerate,
  onResume,
}: {
  state: GenerationState;
  hasReadySource: boolean;
  hasViews: boolean;
  hasCompleteViews: boolean;
  sourcesAreMediaOnly: boolean;
  /** Set while something must finish first; Generate and Resume wait for it. */
  busyReason?: string | null;
  quota?: FreeRequestQuota | null;
  onGenerate: () => void;
  onResume: () => void;
}) {
  const canStart = hasReadySource && !state.busy;
  const hasActiveJob = Boolean(state.jobId && !["succeeded", "failed", "partial"].includes(state.status));
  const hasTerminalResume = Boolean(state.jobId && (state.status === "failed" || state.status === "partial"));
  const resumeAllowed = hasReadySource && (hasActiveJob || hasTerminalResume);
  // The workspace hides this section once every mode exists, so there is no "done" label here.
  const label = resumeAllowed ? "Resume" : hasViews ? "Generate missing" : "Generate";
  const help = !hasReadySource
    ? sourcesAreMediaOnly
      ? "Video and audio only. Upload a PDF, image, or text file."
      : "Needs a Ready source to generate."
    : hasViews
      ? "Fills only study modes that are not generated yet."
      : "Creates Locked In, Summary, Test Me, and Carded.";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={resumeAllowed ? onResume : onGenerate}
          disabled={Boolean(busyReason) || (hasCompleteViews && !resumeAllowed) || (!canStart && !resumeAllowed)}
          title={busyReason ?? (resumeAllowed ? "Resume the saved generation" : help)}
        >
          {state.busy ? <CircleNotch className="animate-spin" weight="bold" /> : <Sparkle weight="fill" />}
          {state.busy ? "Generating" : label}
        </Button>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      {quota ? (
        <p
          className={cn(
            "text-xs",
            quota.remaining < LOW_QUOTA_THRESHOLD ? "text-warning" : "text-muted-foreground",
          )}
        >
          {quota.remaining} of {quota.limit} free requests left today
        </p>
      ) : null}
      {busyReason ? (
        <p role="status" className="text-xs text-muted-foreground">
          {busyReason}
        </p>
      ) : null}
    </div>
  );
}
