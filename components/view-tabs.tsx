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
import { MODE_KIT_ITEMS } from "@/components/mode-kit";
import { SummaryView } from "@/components/summary-view";
import { TestMeView } from "@/components/test-me-view";
import { cn } from "@/lib/utils";
import type { StudyViewSavePatch, ViewsPayload } from "@/lib/serialize-view";
import type { ViewKind } from "@/lib/types";
import type { LockedInDraftController } from "@/components/locked-in-editor";
import type { MutableRefObject } from "react";
import type { SerializedAttemptStats, SerializedCard } from "@/components/reviewer-workspace";

type ViewTabsProps = {
  userId: string;
  views: ViewsPayload;
  viewsLoading?: boolean;
  hasReadySource: boolean;
  showRedo: boolean;
  busy: boolean;
  onRedo: (kind: ViewKind, forceOverwrite?: boolean) => void;
  reviewerId: string;
  cards: SerializedCard[];
  testAttemptStats: SerializedAttemptStats[];
  onCardsChange: (cards: SerializedCard[]) => void;
  onTestAttemptStatsChange: (stats: SerializedAttemptStats[]) => void;
  onViewsChange: (views: ViewsPayload) => void;
  onDraftDirtyChange?: (dirty: boolean) => void;
  draftControllerRef?: MutableRefObject<LockedInDraftController | null>;
  onNavigateRequest?: (kind: ViewKind) => boolean;
  onRedoRequest?: (kind: ViewKind, forceOverwrite: boolean) => boolean;
  compact?: boolean;
  value?: ViewKind;
  onValueChange?: (kind: ViewKind) => void;
};

const MODE_JOB_LINES = Object.fromEntries(
  MODE_KIT_ITEMS.map((item) => [item.kind, item.job]),
) as Record<ViewKind, string>;

const MODE_COPY: Record<
  ViewKind,
  {
    label: string;
    jobLine: string;
    description: string;
    confirmTitle: string;
    confirmBody: string;
  }
> = {
  locked_in: {
    label: "Locked In",
    jobLine: MODE_JOB_LINES.locked_in,
    description:
      "Rebuilds Locked In from your current sources, then rebuilds Summary, Test Me, and Carded.",
    confirmTitle: "Redo Locked In and the other three modes?",
    confirmBody:
      "This replaces Locked In, Summary, Test Me, and Carded with a fresh generation from the current sources.",
  },
  summary: {
    label: "Summary",
    jobLine: MODE_JOB_LINES.summary,
    description:
      "Rebuilds Summary from the current Locked In. Carded is not changed.",
    confirmTitle: "Redo Summary?",
    confirmBody:
      "This replaces Summary using the current Locked In. Carded is not changed.",
  },
  test_me: {
    label: "Test Me",
    jobLine: MODE_JOB_LINES.test_me,
    description: "Rebuilds Test Me from the current Locked In.",
    confirmTitle: "Redo Test Me?",
    confirmBody: "This replaces Test Me using the current Locked In.",
  },
  carded: {
    label: "Carded",
    jobLine: MODE_JOB_LINES.carded,
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
  userId,
  viewsLoading = false,
  hasReadySource,
  showRedo,
  busy,
  onRedo,
  reviewerId,
  cards,
  testAttemptStats,
  onCardsChange,
  onTestAttemptStatsChange,
  onViewsChange,
  onDraftDirtyChange,
  draftControllerRef,
  onNavigateRequest,
  onRedoRequest,
  compact = false,
  value,
  onValueChange,
}: ViewTabsProps) {
  const [uncontrolledTab, setUncontrolledTab] = useState<ViewKind>("locked_in");
  const tab = value ?? uncontrolledTab;
  const [confirmOpen, setConfirmOpen] = useState(false);

  function selectTab(next: ViewKind) {
    if (next !== tab && onNavigateRequest && !onNavigateRequest(next)) return;
    if (value === undefined) setUncontrolledTab(next);
    onValueChange?.(next);
  }

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
    if (onRedoRequest && !onRedoRequest(tab, false)) return;
    onRedo(tab);
  }

  function confirmRedo() {
    setConfirmOpen(false);
    if (onRedoRequest && !onRedoRequest(tab, true)) return;
    onRedo(tab, true);
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => selectTab(next as ViewKind)}
      className="w-full gap-4"
    >
      <div className="overflow-x-auto">
        <TabsList
          variant="line"
          className={cn(
            "min-w-full sm:min-w-0",
            compact && "min-h-11 gap-0 border-b border-border p-0",
          )}
          aria-label="Study modes"
        >
          {MODE_KIT_ITEMS.map((item) => (
            <TabsTrigger
              key={item.kind}
              value={item.kind}
              title={item.job}
              className={cn(
                "min-w-[6.5rem]",
                compact && "min-h-11 min-w-0 flex-1 px-2 py-1.5 text-xs",
              )}
            >
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {compact ? null : (
        <p className="text-xs text-muted-foreground">{copy.jobLine}</p>
      )}

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

      {views.staleKinds?.includes(tab) ? (
        <p role="status" className="max-w-xl rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
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
            userId={userId}
            content={views.locked_in?.content ?? null}
            view={views.locked_in}
            reviewerId={reviewerId}
            onDirtyChange={onDraftDirtyChange}
            controllerRef={draftControllerRef}
            onSaved={(next: StudyViewSavePatch) => {
              onViewsChange({
                ...views,
                locked_in: views.locked_in ? { ...views.locked_in, ...next } : null,
                staleKinds: next.staleKinds ?? views.staleKinds,
              });
            }}
          />
        ) : tab === "summary" ? (
          <SummaryView
            userId={userId}
            content={views.summary?.content ?? null}
            view={views.summary}
            reviewerId={reviewerId}
            onDirtyChange={onDraftDirtyChange}
            controllerRef={draftControllerRef}
            onSaved={(next: StudyViewSavePatch) => {
              onViewsChange({
                ...views,
                summary: views.summary ? { ...views.summary, ...next } : null,
                staleKinds: next.staleKinds ?? views.staleKinds,
              });
            }}
          />
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
