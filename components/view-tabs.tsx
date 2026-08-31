"use client";

import { useState } from "react";
import { ArrowsClockwise, CircleNotch } from "@phosphor-icons/react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { CardedView } from "@/components/carded-view";
import { LockedInView } from "@/components/locked-in-view";
import { SummaryView } from "@/components/summary-view";
import { TestMeView } from "@/components/test-me-view";
import type { ViewsPayload } from "@/lib/serialize-view";
import type { ViewKind } from "@/lib/types";
import type { SerializedAttemptStats, SerializedCard } from "@/components/reviewer-workspace";

type ViewTabsProps = {
  views: ViewsPayload;
  viewsLoading?: boolean;
  hasReadySource: boolean;
  showRedo: boolean;
  busy: boolean;
  error: string | null;
  onRedo: (kind: ViewKind, forceOverwrite?: boolean) => void;
  reviewerId: string;
  cards: SerializedCard[];
  testAttemptStats: SerializedAttemptStats[];
  onCardsChange: (cards: SerializedCard[]) => void;
  onTestAttemptStatsChange: (stats: SerializedAttemptStats[]) => void;
  onViewsChange: (views: ViewsPayload) => void;
};

const MODE_COPY: Record<
  ViewKind,
  {
    label: string;
    description: string;
    confirmTitle: string;
    confirmBody: string;
  }
> = {
  locked_in: {
    label: "Locked In",
    description:
      "Rebuilds Locked In from your current sources, then rebuilds Summary, Test Me, and Carded.",
    confirmTitle: "Redo Locked In and the other three modes?",
    confirmBody:
      "This replaces Locked In, Summary, Test Me, and Carded with a fresh generation from the current sources.",
  },
  summary: {
    label: "Summary",
    description:
      "Rebuilds Summary from the current Locked In. Carded is not changed.",
    confirmTitle: "Redo Summary?",
    confirmBody:
      "This replaces Summary using the current Locked In. Carded is not changed.",
  },
  test_me: {
    label: "Test Me",
    description: "Rebuilds Test Me from the current Locked In.",
    confirmTitle: "Redo Test Me?",
    confirmBody: "This replaces Test Me using the current Locked In.",
  },
  carded: {
    label: "Carded",
    description: "Rebuilds Carded from the current Summary.",
    confirmTitle: "Redo Carded?",
    confirmBody: "This replaces Carded using the current Summary.",
  },
};

function modeHasContent(kind: ViewKind, views: ViewsPayload): boolean {
  const view = views[kind];
  if (!view) return false;
  if (kind === "test_me" || kind === "carded") {
    if (Array.isArray(view.contentJson) && view.contentJson.length > 0) {
      return true;
    }
  }
  return Boolean(view.content?.trim());
}

function redoBlockReason(
  kind: ViewKind,
  views: ViewsPayload,
  hasReadySource: boolean,
): string | null {
  if (kind === "locked_in") {
    return hasReadySource
      ? null
      : "Needs an ingested PDF, image, or text file.";
  }
  if (kind === "summary" || kind === "test_me") {
    return views.locked_in ? null : "Generate Locked In first.";
  }
  return views.summary ? null : "Generate Summary first.";
}

export function ViewTabs({
  views,
  viewsLoading = false,
  hasReadySource,
  showRedo,
  busy,
  error,
  onRedo,
  reviewerId,
  cards,
  testAttemptStats,
  onCardsChange,
  onTestAttemptStatsChange,
  onViewsChange,
}: ViewTabsProps) {
  const [tab, setTab] = useState<ViewKind>("locked_in");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const copy = MODE_COPY[tab];
  const blockReason = redoBlockReason(tab, views, hasReadySource);
  const redoDisabled = busy || viewsLoading || Boolean(blockReason);
  const needsConfirm = modeHasContent(tab, views);

  function requestRedo() {
    if (redoDisabled) return;
    if (needsConfirm) {
      setConfirmOpen(true);
      return;
    }
    onRedo(tab);
  }

  function confirmRedo() {
    setConfirmOpen(false);
    onRedo(tab, true);
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as ViewKind)}
      className="w-full gap-4"
    >
      <div className="overflow-x-auto">
        <TabsList
          variant="line"
          className="min-w-full sm:min-w-0"
          aria-label="Study modes"
        >
          <TabsTrigger value="locked_in" className="min-w-[6.5rem]">
            Locked In
          </TabsTrigger>
          <TabsTrigger value="summary" className="min-w-[6.5rem]">
            Summary
          </TabsTrigger>
          <TabsTrigger value="test_me" className="min-w-[6.5rem]">
            Test Me
          </TabsTrigger>
          <TabsTrigger value="carded" className="min-w-[6.5rem]">
            Carded
          </TabsTrigger>
        </TabsList>
      </div>

      {showRedo ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <Button
            type="button"
            variant="outline"
            disabled={redoDisabled}
            aria-disabled={redoDisabled}
            title={blockReason ?? copy.description}
            onClick={requestRedo}
          >
            {busy ? (
              <>
                <CircleNotch className="animate-spin" weight="bold" />
                Redoing
              </>
            ) : (
              <>
                <ArrowsClockwise weight="bold" />
                Redo
              </>
            )}
          </Button>
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            {blockReason ?? copy.description}
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="max-w-xl text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {views.staleKinds?.includes(tab) ? (
        <p role="status" className="max-w-xl rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          This mode is from an older generation. Redo it when you are ready.
        </p>
      ) : null}

      <TabsContent value={tab} className="outline-none">
        {viewsLoading && !modeHasContent(tab, views) ? (
          <div className="space-y-3" aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading {copy.label}</span>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        ) : tab === "locked_in" ? (
          <LockedInView
            content={views.locked_in?.content ?? null}
            view={views.locked_in}
            reviewerId={reviewerId}
            onSaved={(next) => {
              onViewsChange({
                ...views,
                locked_in: views.locked_in ? { ...views.locked_in, ...next } : null,
                staleKinds: ["summary", "test_me", "carded"],
              });
            }}
          />
        ) : tab === "summary" ? (
          <SummaryView content={views.summary?.content ?? null} />
        ) : tab === "test_me" ? (
          <TestMeView
            contentJson={views.test_me?.contentJson ?? null}
            content={views.test_me?.content ?? null}
            reviewerId={reviewerId}
            viewRevision={views.test_me?.revision ?? 1}
            attemptStats={testAttemptStats}
            onAttemptStatsChange={onTestAttemptStatsChange}
          />
        ) : (
          <CardedView
            contentJson={views.carded?.contentJson ?? null}
            content={views.carded?.content ?? null}
            reviewerId={reviewerId}
            durableCards={cards}
            onCardsChange={onCardsChange}
          />
        )}
      </TabsContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.confirmTitle}</DialogTitle>
            <DialogDescription>{copy.confirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="button" onClick={confirmRedo} disabled={busy}>
              {busy ? (
                <>
                  <CircleNotch className="animate-spin" />
                  Redoing
                </>
              ) : (
                "Redo"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
