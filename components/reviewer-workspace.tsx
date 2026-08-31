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
  examDate: string | null;
  initialCards: SerializedCard[];
  initialTestAttemptStats: SerializedAttemptStats[];
};

export type SerializedCard = {
  id: string;
  sourceKey: string;
  front: string;
  back: string;
  kind?: "basic" | "cloze";
  revision: number;
  isEdited: boolean;
  isPinned: boolean;
  dueAt: string;
  intervalDays: number;
  repetitions: number;
  easeFactor: number;
  lastReviewedAt: string | null;
};

export type SerializedAttemptStats = {
  itemId: string;
  attempts: number;
  misses: number;
  lastAttemptedAt: string | null;
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
  const stamps = [
    views.locked_in?.generatedAt,
    views.summary?.generatedAt,
    views.test_me?.generatedAt,
    views.carded?.generatedAt,
  ].filter((stamp): stamp is string => Boolean(stamp));
  return stamps.length > 0
    ? stamps.reduce((latest, stamp) =>
        Date.parse(stamp) > Date.parse(latest) ? stamp : latest,
      )
    : null;
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
  examDate,
  initialCards,
  initialTestAttemptStats,
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
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [cards, setCards] = useState(initialCards);
  const [testAttemptStats, setTestAttemptStats] = useState(initialTestAttemptStats);
  const [currentExamDate, setCurrentExamDate] = useState(examDate);
  const [examDateDraft, setExamDateDraft] = useState(examDate ?? "");
  const [examDateBusy, setExamDateBusy] = useState(false);
  const [examDateError, setExamDateError] = useState<string | null>(null);
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
    let cancelled = false;

    async function loadActiveGeneration() {
      try {
        const res = await fetch(`/api/reviewers/${reviewerId}/generation`);
        if (!res.ok) return;
        const data = (await res.json()) as {
          job: { id: string } | null;
          views: ViewsPayload | null;
        };
        if (cancelled || !data.job) return;
        setActiveJobId(data.job.id);
        if (data.views) {
          setViews(data.views);
          const stamp = stampFromViews(data.views);
          if (stamp) setGeneratedAt(stamp);
        }
      } catch {
        // Active-job discovery is advisory; the explicit Generate action can
        // still start or resume a run if this read is temporarily unavailable.
      }
    }

    void loadActiveGeneration();
    return () => {
      cancelled = true;
    };
  }, [reviewerId]);

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
    if (next.carded) {
      void fetch(`/api/reviewers/${reviewerId}/cards`)
        .then(async (response) => {
          if (!response.ok) return null;
          return (await response.json()) as { cards: SerializedCard[] };
        })
        .then((data) => {
          if (data) setCards(data.cards);
        })
        .catch(() => undefined);
    }
  }

  async function redo(kind: ViewKind, forceOverwrite = false) {
    setRedoBusy(true);
    setRedoError(null);
    try {
      const expectedProtected = [
        ...(["locked_in", "summary", "test_me", "carded"] as const)
          .map((viewKind) => views[viewKind])
          .filter((view): view is NonNullable<typeof view> => Boolean(view))
          .map((view) => ({ key: `view:${view.kind}`, revision: view.revision })),
        ...cards.map((card) => ({ key: `card:${card.id}`, revision: card.revision })),
      ];
      const res = await fetch(`/api/reviewers/${reviewerId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, forceOverwrite, expectedProtected }),
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
        setActiveJobId(data.jobId);
        const maxAttempts = 180;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const poll = await fetch(
            `/api/reviewers/${reviewerId}/generation/${data.jobId}`,
            { method: "POST" },
          );
          let job: {
            status: string;
            views?: ViewsPayload;
            error?: { message?: string } | string | null;
          } | null = null;
          try {
            job = (await poll.json()) as {
              status: string;
              views?: ViewsPayload;
              error?: { message?: string } | string | null;
            };
          } catch {
            job = null;
          }
          if (!poll.ok && !job?.status) {
            setRedoError(await readApiError(poll));
            return;
          }
          if (!job) {
            setRedoError("Generation returned an invalid response.");
            return;
          }
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
            setActiveJobId(null);
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

  async function saveExamDate() {
    setExamDateBusy(true);
    setExamDateError(null);
    try {
      const res = await fetch(`/api/reviewers/${reviewerId}/exam-date`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examDate: examDateDraft || null }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { examDate: string | null };
      setCurrentExamDate(data.examDate);
      setExamDateDraft(data.examDate ?? "");
    } catch (error) {
      setExamDateError(error instanceof Error ? error.message : "Could not save exam date.");
    } finally {
      setExamDateBusy(false);
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
        <div className="flex flex-wrap items-end gap-2 pt-3">
          <label
            htmlFor="exam-date"
            className="grid gap-1 text-xs text-muted-foreground"
          >
            Exam date
            <input
              id="exam-date"
              name="examDate"
              type="date"
              value={examDateDraft}
              onChange={(event) => setExamDateDraft(event.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            />
          </label>
          <button
            type="button"
            className="h-9 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            onClick={() => void saveExamDate()}
            disabled={examDateBusy || examDateDraft === (currentExamDate ?? "")}
          >
            {examDateBusy ? "Saving" : "Save date"}
          </button>
          {currentExamDate ? <p className="pb-2 text-xs text-muted-foreground">Cards will be scheduled no later than this date.</p> : null}
          {examDateError ? <p role="alert" className="basis-full text-xs text-destructive">{examDateError}</p> : null}
        </div>
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
          activeJobId={activeJobId}
          onGenerated={applyGenerated}
          onGenerationFinished={() => setActiveJobId(null)}
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
          cards={cards}
          testAttemptStats={testAttemptStats}
          reviewerId={reviewerId}
          onCardsChange={setCards}
          onTestAttemptStatsChange={setTestAttemptStats}
          onViewsChange={setViews}
          onRedo={(kind, forceOverwrite) => void redo(kind, forceOverwrite)}
        />
      </section>
    </div>
  );
}
