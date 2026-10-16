"use client";

import { CircleNotch, Sparkle } from "@phosphor-icons/react";

import { KirbyCompanion } from "@/components/kirby-companion";
import { Button } from "@/components/ui/button";
import { freeRequestsUsedUp, packsLeftCopy, type FreeRequestState } from "@/lib/generation-queue";
import type { GenerationState } from "@/lib/use-generation";
import { cn } from "@/lib/utils";


export function GenerationControls({
  state,
  hasReadySource,
  hasViews,
  hasCompleteViews,
  sourcesAreMediaOnly,
  busyReason = null,
  quota,
  fullKirby = true,
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
  quota?: FreeRequestState | null;
  /** False while the section already shows a Kirby (inhale or puzzled): one per area. */
  fullKirby?: boolean;
  onGenerate: () => void;
  onResume: () => void;
}) {
  const canStart = hasReadySource && !state.busy;
  const hasActiveJob = Boolean(state.jobId && !["succeeded", "failed", "partial"].includes(state.status));
  const hasTerminalResume = Boolean(state.jobId && (state.status === "failed" || state.status === "partial"));
  const resumeAllowed = hasReadySource && (hasActiveJob || hasTerminalResume);
  // The workspace hides this section once every mode exists, so there is no "done" label here.
  const label = resumeAllowed ? "Resume" : hasViews ? "Generate missing" : "Generate";
  const quotaLine = quota ? packsLeftCopy(quota) : null;
  const usedUp = freeRequestsUsedUp(quota);
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
      {quotaLine ? (
        <div className="flex items-center gap-2">
          {/* Free requests reset at 00:00 UTC, 8:00 AM in Manila. */}
          <p className={cn("text-xs", quotaLine.low ? "text-warning" : "text-muted-foreground")}>
            {quotaLine.text}
          </p>
          {/* Full tummy: nothing left to inhale today (Dream Land only). */}
          {usedUp && fullKirby ? <KirbyCompanion size="xs" pose="full" className="shrink-0" /> : null}
        </div>
      ) : null}
      {busyReason ? (
        <p role="status" className="text-xs text-muted-foreground">
          {busyReason}
        </p>
      ) : null}
    </div>
  );
}
