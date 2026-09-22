"use client";

import { CircleNotch, Sparkle } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import type { GenerationState } from "@/lib/use-generation";

export function GenerationControls({
  state,
  hasReadySource,
  hasViews,
  hasCompleteViews,
  sourcesAreMediaOnly,
  onGenerate,
  onResume,
}: {
  state: GenerationState;
  hasReadySource: boolean;
  hasViews: boolean;
  hasCompleteViews: boolean;
  sourcesAreMediaOnly: boolean;
  onGenerate: () => void;
  onResume: () => void;
}) {
  const canStart = hasReadySource && !state.busy;
  const hasActiveJob = Boolean(state.jobId && !["succeeded", "failed", "partial"].includes(state.status));
  const hasTerminalResume = Boolean(state.jobId && (state.status === "failed" || state.status === "partial"));
  const label = hasActiveJob || hasTerminalResume ? "Resume" : hasCompleteViews ? "All generated" : hasViews ? "Generate missing" : "Generate";
  const help = !hasReadySource
    ? sourcesAreMediaOnly
      ? "Video and audio only. Upload a PDF, image, or text file."
      : "Needs a Ready source to generate."
    : hasCompleteViews
      ? "All four study modes are generated. Use Redo on a mode to rebuild it."
      : hasViews
      ? "Fills only study modes that are not generated yet."
      : "Creates Locked In, Summary, Test Me, and Carded.";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={hasActiveJob || hasTerminalResume ? onResume : onGenerate}
          disabled={(hasCompleteViews && !hasTerminalResume) || (!canStart && !hasActiveJob && !hasTerminalResume)}
          title={hasActiveJob || hasTerminalResume ? "Resume the saved generation" : help}
        >
          {state.busy ? <CircleNotch className="animate-spin" weight="bold" /> : <Sparkle weight="fill" />}
          {state.busy ? "Generating" : label}
        </Button>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
    </div>
  );
}
