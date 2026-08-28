"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import {
  GenerateButton,
  type ViewsPayload,
} from "@/components/generate-button";
import {
  SourcePanel,
  type SourceListItem,
} from "@/components/source-panel";
import { ViewTabs } from "@/components/view-tabs";
import { Separator } from "@/components/ui/separator";
import { formatStampLocal, formatStampUtc } from "@/lib/format-generated-at";
import type { ViewKind } from "@/lib/types";
import { useIsClient } from "@/lib/use-is-client";
import { readApiError } from "@/lib/utils";

type ReviewerWorkspaceProps = {
  userId: string;
  topicId: string;
  topicName: string;
  reviewerId: string;
  reviewerName: string;
  initialSources: SourceListItem[];
  initialViews: ViewsPayload;
  lastGeneratedAt: string | null;
};

const NOT_GENERATED_YET =
  "Not generated yet. Upload Ready sources, then generate.";

function needsViewBodies(views: ViewsPayload): boolean {
  const kinds: ViewKind[] = ["locked_in", "summary", "test_me", "carded"];
  return kinds.some((kind) => {
    const view = views[kind];
    if (!view) return false;
    const hasJson =
      Array.isArray(view.contentJson) && view.contentJson.length > 0;
    return !view.content?.trim() && !hasJson;
  });
}

function stampFromViews(views: ViewsPayload): string | null {
  return (
    views.locked_in?.generatedAt ??
    views.summary?.generatedAt ??
    views.test_me?.generatedAt ??
    views.carded?.generatedAt ??
    null
  );
}

export function ReviewerWorkspace({
  userId,
  topicId,
  topicName,
  reviewerId,
  reviewerName,
  initialSources,
  initialViews,
  lastGeneratedAt,
}: ReviewerWorkspaceProps) {
  const [sources, setSources] = useState(initialSources);
  const [views, setViews] = useState(initialViews);
  const [generatedAt, setGeneratedAt] = useState(lastGeneratedAt);
  const [viewsLoading, setViewsLoading] = useState(() =>
    needsViewBodies(initialViews),
  );
  const [viewsError, setViewsError] = useState<string | null>(null);
  const [viewsReload, setViewsReload] = useState(0);
  const [redoBusy, setRedoBusy] = useState(false);
  const [redoError, setRedoError] = useState<string | null>(null);
  const isClient = useIsClient();
  const generatedStamp = generatedAt
    ? isClient
      ? formatStampLocal(generatedAt)
      : formatStampUtc(generatedAt)
    : null;
  const generatedLabel = !generatedAt
    ? NOT_GENERATED_YET
    : generatedStamp
      ? `Last generated ${generatedStamp}`
      : "Last generated";

  const hasReadySource = useMemo(
    () => sources.some((s) => s.ingestStatus === "ready"),
    [sources],
  );

  const hasViews = useMemo(
    () =>
      Boolean(
        views.locked_in || views.summary || views.test_me || views.carded,
      ),
    [views],
  );

  const sourcesAreMediaOnly = useMemo(() => {
    if (sources.length === 0) return false;
    return sources.every(
      (s) => s.kind === "video" || s.kind === "audio" || s.ingestStatus === "unprocessed",
    );
  }, [sources]);

  useEffect(() => {
    if (!needsViewBodies(initialViews)) return;
    let cancelled = false;

    async function loadBodies() {
      setViewsLoading(true);
      setViewsError(null);
      try {
        const res = await fetch(`/api/reviewers/${reviewerId}/views`);
        if (!res.ok) {
          throw new Error(await readApiError(res));
        }
        const data = (await res.json()) as ViewsPayload;
        if (!cancelled) {
          setViews(data);
          const stamp = stampFromViews(data);
          if (stamp) setGeneratedAt(stamp);
        }
      } catch (err) {
        if (!cancelled) {
          setViewsError(
            err instanceof Error
              ? err.message
              : "Could not load study modes. Try again.",
          );
        }
      } finally {
        if (!cancelled) setViewsLoading(false);
      }
    }

    void loadBodies();
    return () => {
      cancelled = true;
    };
  }, [reviewerId, initialViews, viewsReload]);

  function applyGenerated(next: ViewsPayload) {
    setViews(next);
    setGeneratedAt(stampFromViews(next) ?? new Date().toISOString());
  }

  async function redo(kind: ViewKind) {
    setRedoBusy(true);
    setRedoError(null);
    try {
      const res = await fetch(`/api/reviewers/${reviewerId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!res.ok) {
        setRedoError(await readApiError(res));
        return;
      }
      const data = (await res.json()) as ViewsPayload & {
        jobId?: string;
        views?: ViewsPayload;
      };
      if (data.jobId) {
        const maxAttempts = 180;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const poll = await fetch(
            `/api/reviewers/${reviewerId}/generation/${data.jobId}`,
          );
          if (!poll.ok) {
            setRedoError(await readApiError(poll));
            return;
          }
          const job = (await poll.json()) as {
            status: string;
            views?: ViewsPayload;
            error?: { message?: string } | string | null;
          };
          if (
            job.status === "succeeded" ||
            job.status === "failed" ||
            job.status === "partial"
          ) {
            if (job.views) applyGenerated(job.views);
            if (job.status !== "succeeded") {
              const msg =
                typeof job.error === "string"
                  ? job.error
                  : job.error?.message;
              if (msg) setRedoError(msg);
            }
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        setRedoError("Generation is taking too long. Refresh and check views.");
        return;
      }
      applyGenerated(data);
    } catch {
      setRedoError("Generation failed. Try again in a moment.");
    } finally {
      setRedoBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="space-y-1">
        <nav className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <Link
            href={`/?topic=${topicId}`}
            className="rounded outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
          >
            {topicName}
          </Link>
          <span aria-hidden>/</span>
          <span className="text-foreground">{reviewerName}</span>
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[1.75rem]">
          {reviewerName}
        </h1>
        <p className="text-sm text-muted-foreground" suppressHydrationWarning>
          {generatedLabel}
        </p>
      </div>

      <SourcePanel
        userId={userId}
        reviewerId={reviewerId}
        initialSources={initialSources}
        onSourcesChange={setSources}
      />

      <section className="space-y-3" aria-labelledby="generate-heading">
        <div>
          <h2
            id="generate-heading"
            className="text-sm font-semibold tracking-tight text-foreground"
          >
            Study pack
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hasViews
              ? "To rebuild all four, open Locked In and use Redo."
              : "Generate writes Locked In, Summary, Test Me, and Carded from your ingested sources."}
          </p>
        </div>
        <GenerateButton
          reviewerId={reviewerId}
          hasReadySource={hasReadySource}
          hasViews={hasViews}
          sourcesAreMediaOnly={sourcesAreMediaOnly}
          onGenerated={applyGenerated}
        />
      </section>

      <Separator />

      <section className="space-y-3" aria-labelledby="views-heading">
        <h2
          id="views-heading"
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          Study modes
        </h2>
        {viewsError ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {viewsError}
            </p>
            <button
              type="button"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              onClick={() => setViewsReload((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : null}
        <ViewTabs
          views={views}
          viewsLoading={viewsLoading}
          hasReadySource={hasReadySource}
          showRedo={hasViews}
          busy={redoBusy}
          error={redoError}
          onRedo={(kind) => void redo(kind)}
        />
      </section>
    </div>
  );
}
