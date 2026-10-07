"use client";

import { Fragment, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowsClockwise, CircleNotch, DotsThreeVertical } from "@phosphor-icons/react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { CardedView } from "@/components/carded-view";
import { FocusToggle, useFocusMode } from "@/components/focus-mode";
import { LOW_QUOTA_THRESHOLD, type FreeRequestQuota } from "@/components/generation-controls";
import { LockedInView } from "@/components/locked-in-view";
import { MODE_KIT_ITEMS } from "@/components/mode-kit";
import {
  ModeToolbarProvider,
  useModeMenuItemsValue,
  useModeToolbarSlotRef,
  type ModeMenuItem,
} from "@/components/mode-toolbar";
import { SourceViewerProvider, useSourceViewer, type PackSourceRef } from "@/components/source-modal";
import { StudyPackContext } from "@/components/study-document";
import { citationSourcesForMode } from "@/lib/citations";
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
  /** Set while something must finish first; Redo shows it and waits. */
  busyReason?: string | null;
  /** Free requests left today on the shared key; shown beside Redo. */
  quota?: FreeRequestQuota | null;
  onRedo: (kind: ViewKind, forceOverwrite?: boolean) => void;
  reviewerId: string;
  reviewerName?: string;
  /** The pack's uploads, so a search link can open a page by upload id. */
  packSources?: PackSourceRef[];
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
  examDate?: string | null;
  value?: ViewKind;
  onValueChange?: (kind: ViewKind) => void;
  /** Pack-level More items from the workspace (Sources, Exam date). */
  packMenuItems?: ModeMenuItem[];
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A search result can link to `?sourceId=<uuid>&page=<p>` (or `?source=<n>&page=<p>`). Open that page in the
 * source viewer, then drop those params so a reload or a shared URL does
 * not reopen it. Other params and the hash stay.
 */
function SourceDeepLink() {
  const searchParams = useSearchParams();
  const { openSource, openSourceById } = useSourceViewer();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("sourceId") && !params.has("source") && !params.has("page")) return;
    const sourceId = params.get("sourceId") ?? "";
    const source = Number(params.get("source"));
    const page = Number.isInteger(Number(params.get("page"))) && Number(params.get("page")) >= 1 ? Number(params.get("page")) : null;
    // The upload id works for any pack; the citation index only resolves where the view stores its list.
    const opened = UUID_PATTERN.test(sourceId) && openSourceById({ sourceId, page });
    if (!opened && Number.isInteger(source) && source >= 1) openSource({ source, page });
    params.delete("sourceId");
    params.delete("source");
    params.delete("page");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [openSource, openSourceById, searchParams]);

  return null;
}

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
  busyReason = null,
  quota,
  onRedo,
  reviewerId,
  reviewerName = "",
  packSources,
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
  examDate = null,
  value,
  onValueChange,
  packMenuItems = [],
}: ViewTabsProps) {
  const [uncontrolledTab, setUncontrolledTab] = useState<ViewKind>("locked_in");
  const tab = value ?? uncontrolledTab;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { setAllowed: setFocusAllowed } = useFocusMode();

  // Focus mode only applies to the one-item-at-a-time modes.
  useEffect(() => {
    setFocusAllowed(tab === "carded" || tab === "test_me");
  }, [setFocusAllowed, tab]);
  useEffect(() => () => setFocusAllowed(false), [setFocusAllowed]);

  function selectTab(next: ViewKind) {
    if (next !== tab && onNavigateRequest && !onNavigateRequest(next)) return;
    if (value === undefined) setUncontrolledTab(next);
    onValueChange?.(next);
  }

  // Each mode resolves chips against the source list of its own generation.
  const citationSources = useMemo(() => citationSourcesForMode(views, tab), [tab, views]);
  const studyPack = useMemo(() => ({ reviewerName }), [reviewerName]);

  const copy = MODE_COPY[tab];
  const blockReason = busyReason ?? redoBlockReason(tab, views, hasReadySource);
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
    <SourceViewerProvider reviewerId={reviewerId} citationSources={citationSources} packSources={packSources}>
    <StudyPackContext.Provider value={studyPack}>
    <Suspense fallback={null}>
      <SourceDeepLink />
    </Suspense>
    <ModeToolbarProvider>
    <Tabs
      value={tab}
      onValueChange={(next) => selectTab(next as ViewKind)}
      className="w-full gap-4"
    >
      {/* One sticky strip: tabs left; the active mode's tools (portaled into the slot), Focus and More right.
          No overflow here: it would clip the menus and the Contents popover. The tab list scrolls instead. */}
      {/* The wrapper stays in Focus mode so the Focus toggle (the way out, and where focus lands) stays visible;
          tabs, mode tools and More hide individually. */}
      <div className="print-hide sticky top-14 z-20 -mx-1 flex flex-wrap items-end gap-x-2 gap-y-1 border-b border-border bg-background px-1 pt-2 in-data-[focus=on]:border-b-0">
        <TabsList
          data-focus-hide
          variant="line"
          className={cn(
            "min-w-0 flex-1 overflow-x-auto border-b-0",
            compact && "min-h-11 gap-0 p-0",
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
                compact && "min-h-11 min-w-0 flex-1 px-2 py-1.5 text-sm",
              )}
            >
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex shrink-0 items-center gap-1 pb-1 max-sm:w-full max-sm:justify-end">
          <ModeToolsSlot />
          <FocusToggle />
          <MoreMenu
            packItems={packMenuItems}
            redo={
              showRedo
                ? {
                    label: busy ? "Redoing" : `Redo ${copy.label}`,
                    busy,
                    disabled: redoDisabled,
                    hint: blockReason ?? copy.description,
                    remaining: blockReason ? null : quota?.remaining ?? null,
                    onSelect: requestRedo,
                  }
                : null
            }
          />
        </div>
      </div>
      {compact ? null : (
        <p data-focus-hide className="print-hide text-xs text-muted-foreground">{copy.jobLine}</p>
      )}

      {views.staleKinds?.includes(tab) && modeHasContent(tab, views) ? (
        <p role="status" data-focus-hide className="print-hide max-w-xl rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
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
            lockedIn={views.locked_in?.content ?? null}
          />
        ) : (
          <CardedView
            contentJson={views.carded?.contentJson ?? null}
            content={views.carded?.content ?? null}
            reviewerId={reviewerId}
            durableCards={cards}
            examDate={examDate}
            onCardsChange={onCardsChange}
            lockedIn={views.locked_in?.content ?? null}
            reviewerName={reviewerName}
          />
        )}
      </TabsContent>
      {/* Scroll jump's "Jump to end" target: the end of the study content, above the sources footer. */}
      <div data-study-end aria-hidden className="h-px" />

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
    </ModeToolbarProvider>
    </StudyPackContext.Provider>
    </SourceViewerProvider>
  );
}

/** The strip element the active mode's tools render into (relative: the Contents popover positions against it). */
function ModeToolsSlot() {
  const slotRef = useModeToolbarSlotRef();
  return <div ref={slotRef} data-focus-hide className="relative flex items-center gap-1 empty:hidden" />;
}

type RedoMenuEntry = {
  label: string;
  busy: boolean;
  disabled: boolean;
  /** The block reason when blocked, else the mode's one-line description. */
  hint: string;
  remaining: number | null;
  onSelect: () => void;
};

const MENU_ITEM_CLASS = "items-start pointer-coarse:min-h-11";

function MenuItemText({ label, hint }: { label: ReactNode; hint?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span>{label}</span>
      {hint ? <span className="text-xs leading-snug text-muted-foreground">{hint}</span> : null}
    </span>
  );
}

/**
 * The strip's one More menu: the active mode's registered items, Redo for the
 * active mode, then the pack's items. Groups are separated only when present.
 */
function MoreMenu({ packItems, redo }: { packItems: ModeMenuItem[]; redo: RedoMenuEntry | null }) {
  const modeItems = useModeMenuItemsValue();
  if (modeItems.length === 0 && !redo && packItems.length === 0) return null;
  const groups: ReactNode[] = [];
  if (modeItems.length > 0) {
    groups.push(
      modeItems.map((item) => (
        <DropdownMenuItem key={item.id} className={MENU_ITEM_CLASS} disabled={item.disabled} onClick={item.onSelect}>
          <MenuItemText label={item.label} hint={item.hint} />
        </DropdownMenuItem>
      )),
    );
  }
  if (redo) {
    groups.push(
      <DropdownMenuItem key="redo" className={MENU_ITEM_CLASS} disabled={redo.disabled} onClick={redo.onSelect}>
        {redo.busy ? (
          <CircleNotch className="mt-0.5 animate-spin" weight="bold" />
        ) : (
          <ArrowsClockwise className="mt-0.5" weight="bold" />
        )}
        <MenuItemText
          label={redo.label}
          hint={
            <>
              {redo.hint}
              {redo.remaining !== null ? (
                <>
                  {" "}
                  <span className={redo.remaining < LOW_QUOTA_THRESHOLD ? "text-warning" : undefined}>
                    {redo.remaining} left today.
                  </span>
                </>
              ) : null}
            </>
          }
        />
      </DropdownMenuItem>,
    );
  }
  if (packItems.length > 0) {
    groups.push(
      packItems.map((item) => (
        <DropdownMenuItem key={item.id} className={MENU_ITEM_CLASS} disabled={item.disabled} onClick={item.onSelect}>
          <MenuItemText label={item.label} hint={item.hint} />
        </DropdownMenuItem>
      )),
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-focus-hide
            className="pointer-coarse:size-11"
            aria-label="More actions"
          />
        }
      >
        <DotsThreeVertical weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64 max-w-80">
        {groups.map((group, index) => (
          <Fragment key={index}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {group}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
