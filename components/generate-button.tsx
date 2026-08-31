"use client";

import { useState } from "react";
import { ArrowsClockwise, CircleNotch, Sparkle } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ViewsPayload } from "@/lib/serialize-view";
import { readApiError } from "@/lib/utils";

export type { SerializedView, ViewsPayload } from "@/lib/serialize-view";

type ClassifiedError = {
  code?: string | null;
  message: string;
  retryable?: boolean;
};

type GenerateResponse = {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "partial";
  step: string | null;
  views?: ViewsPayload;
  error?: ClassifiedError | string;
};

type JobPollResponse = {
  job: {
    id: string;
    status: GenerateResponse["status"];
    step: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  };
  status: GenerateResponse["status"];
  step: string | null;
  views: ViewsPayload;
  error: ClassifiedError | null;
};

type GenerateButtonProps = {
  reviewerId: string;
  hasReadySource: boolean;
  hasViews: boolean;
  sourcesAreMediaOnly: boolean;
  activeJobId?: string | null;
  onGenerated: (views: ViewsPayload) => void;
  onGenerationFinished?: () => void;
};

const STEP_LABELS: Record<string, string> = {
  locked_in: "Locked In",
  summary: "Summary",
  test_me: "Test Me",
  carded: "Carded",
};

function formatStep(step: string | null | undefined): string | null {
  if (!step) return null;
  return STEP_LABELS[step] ?? step;
}

function errorMessageFromUnknown(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const obj = data as Record<string, unknown>;
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as ClassifiedError;
    if (typeof err.message === "string" && err.message.trim()) {
      return err.retryable
        ? `${err.message} You can retry.`
        : err.message;
    }
  }
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error;
  return fallback;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function GenerateButton({
  reviewerId,
  hasReadySource,
  hasViews,
  sourcesAreMediaOnly,
  activeJobId = null,
  onGenerated,
  onGenerationFinished,
}: GenerateButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);

  if (hasViews && !activeJobId) return null;

  const disabled = busy || (!hasReadySource && !activeJobId);

  async function pollJob(jobId: string): Promise<JobPollResponse> {
    const maxAttempts = 180;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // POST claims at most one current step. A concurrent browser receives
      // the live lease and simply polls again without issuing model work.
      const stepRes = await fetch(
        `/api/reviewers/${reviewerId}/generation/${jobId}`,
        { method: "POST" },
      );
      let data: JobPollResponse | null = null;
      try {
        data = (await stepRes.json()) as JobPollResponse;
      } catch {
        data = null;
      }
      if (!stepRes.ok && !data?.status) {
        throw new Error(await readApiError(stepRes));
      }
      if (!data) throw new Error("Generation returned an invalid response.");
      setCurrentStep(data.step);
      if (data.views) onGenerated(data.views);
      if (
        data.status === "succeeded" ||
        data.status === "failed" ||
        data.status === "partial"
      ) {
        return data;
      }
      await sleep(1500);
    }
    throw new Error("Generation is taking too long. Refresh and check views.");
  }

  async function runGenerate(existingJobId?: string | null) {
    setBusy(true);
    setError(null);
    setCurrentStep("locked_in");
    try {
      let data: GenerateResponse | null = null;
      let res: Response | null = null;
      if (!existingJobId) {
        res = await fetch(`/api/reviewers/${reviewerId}/generate`, {
          method: "POST",
        });
        try {
          data = (await res.json()) as GenerateResponse;
        } catch {
          data = null;
        }
      }

      const jobId = existingJobId ?? data?.jobId;
      if (jobId) {
        if (!data) {
          data = {
            jobId,
            status: "queued",
            step: "locked_in",
          };
        }
        setCurrentStep(data.step);
        // Long POST may already be terminal; otherwise poll until done.
        if (
          data.status === "succeeded" ||
          data.status === "failed" ||
          data.status === "partial"
        ) {
          if (data.views) onGenerated(data.views);
          if (data.status === "succeeded") {
            onGenerationFinished?.();
            setConfirmOpen(false);
            setCurrentStep(null);
            return;
          }
          setError(
            errorMessageFromUnknown(
              data,
              data.status === "partial"
                ? "Generation stopped partway. Successful views were kept."
                : "Generation failed. Try again in a moment.",
            ),
          );
          if (data.status === "partial") setConfirmOpen(false);
          onGenerationFinished?.();
          return;
        }

        const polled = await pollJob(jobId);
        if (polled.views) onGenerated(polled.views);
        if (polled.status === "succeeded") {
          onGenerationFinished?.();
          setConfirmOpen(false);
          setCurrentStep(null);
          return;
        }
        setError(
          errorMessageFromUnknown(
            polled,
            polled.status === "partial"
              ? "Generation stopped partway. Successful views were kept."
              : "Generation failed. Try again in a moment.",
          ),
        );
        if (polled.status === "partial") setConfirmOpen(false);
        onGenerationFinished?.();
        return;
      }

      if (res && !res.ok) {
        setError(
          data
            ? errorMessageFromUnknown(data, "Generation failed. Try again in a moment.")
            : "Generation failed. Try again in a moment.",
        );
        return;
      }

      setError("Unexpected generate response. Try again.");
    } catch {
      setError("Generation failed. Try again in a moment.");
    } finally {
      setBusy(false);
      setCurrentStep(null);
    }
  }

  function handleClick() {
    setError(null);
    if (!hasReadySource && !activeJobId) {
      if (sourcesAreMediaOnly) {
        setError(
          "This pack only has video or audio. Those are not processed in v1, so generation cannot run yet. Upload a PDF, image, or text file.",
        );
      } else {
        setError(
          "Add at least one Ready source before generating. Video and audio stay unprocessed in v1.",
        );
      }
      return;
    }
    if (hasViews && !activeJobId) {
      setConfirmOpen(true);
      return;
    }
    void runGenerate(activeJobId);
  }

  const stepLabel = formatStep(currentStep);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={handleClick}
          disabled={disabled}
          aria-disabled={disabled}
          title={
            !hasReadySource
              ? "Needs at least one Ready source"
              : hasViews
                ? "Regenerate all four views"
            : activeJobId
              ? "Resume generation"
              : "Generate all four views"
          }
        >
          {busy ? (
            <>
              <CircleNotch className="animate-spin" weight="bold" />
              Generating
            </>
          ) : activeJobId ? (
            <>
              <CircleNotch weight="bold" />
              Resume
            </>
          ) : hasViews ? (
            <>
              <ArrowsClockwise weight="bold" />
              Regenerate
            </>
          ) : (
            <>
              <Sparkle weight="fill" />
              Generate
            </>
          )}
        </Button>
        {!hasReadySource ? (
          <p className="text-xs text-muted-foreground">
            {sourcesAreMediaOnly
              ? "Video and audio only. Upload a PDF, image, or text file."
              : "Needs a Ready source to generate."}
          </p>
        ) : null}
        {busy && stepLabel ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Working on {stepLabel}
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="max-w-xl text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regenerate study views?</DialogTitle>
            <DialogDescription>
              This replaces Locked In, Summary, Test Me, and Carded with a fresh
              generation from the current Ready sources.
            </DialogDescription>
          </DialogHeader>
          {busy && stepLabel ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Working on {stepLabel}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void runGenerate()}
              disabled={busy}
            >
              {busy ? (
                <>
                  <CircleNotch className="animate-spin" />
                  Regenerating
                </>
              ) : (
                "Regenerate"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
