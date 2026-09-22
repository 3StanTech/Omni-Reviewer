"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CaretDown, CaretUp } from "@phosphor-icons/react";

import type { ViewsPayload } from "@/lib/serialize-view";
import {
  SourcePanel,
  type SourceListItem,
} from "@/components/source-panel";
import { ViewTabs } from "@/components/view-tabs";
import { GenerationControls } from "@/components/generation-controls";
import { GenerationStatus } from "@/components/generation-status";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatStampLocal, formatStampUtc } from "@/lib/format-generated-at";
import type { ViewKind } from "@/lib/types";
import { useIsClient } from "@/lib/use-is-client";
import { readApiError } from "@/lib/utils";
import { useGeneration } from "@/lib/use-generation";
import type { GenerationRequest } from "@/lib/generation-plan";
import type { LockedInDraftController } from "@/components/locked-in-editor";
import {
  attachDraftHistoryGuard,
  browserDraftNavigation,
  browserSupportsPrecommitHandler,
  type DraftHistoryGuard,
} from "@/lib/draft-history-guard";

type PendingDraftAction =
  | { type: "mode"; kind: ViewKind }
  | { type: "redo"; kind: ViewKind; forceOverwrite: boolean }
  | { type: "href"; href: string }
  | { type: "history"; delta: number };

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
  initialMode?: ViewKind;
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
const MS_PER_DAY = 86_400_000;

function examCountdownCopy(examDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const examStart = new Date(year, month - 1, day);
  const days = Math.round((examStart.getTime() - todayStart.getTime()) / MS_PER_DAY);
  if (days > 0) return `Exam in ${days} days`;
  if (days === 0) return "Exam today";
  return "Exam date passed";
}

function viewsExist(views: ViewsPayload): boolean {
  return Boolean(
    views.locked_in || views.summary || views.test_me || views.carded,
  );
}

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
  initialMode = "locked_in",
}: ReviewerWorkspaceProps) {
  const [sources, setSources] = useState(initialSources);
  const [views, setViews] = useState(initialViews);
  const [generatedAt, setGeneratedAt] = useState(lastGeneratedAt);
  const [viewsLoading, setViewsLoading] = useState(() =>
    needsViewBodies(initialViews),
  );
  const [viewsError, setViewsError] = useState<string | null>(null);
  const [viewsReload, setViewsReload] = useState(0);
  const [cards, setCards] = useState(initialCards);
  const [testAttemptStats, setTestAttemptStats] = useState(initialTestAttemptStats);
  const [currentExamDate, setCurrentExamDate] = useState(examDate);
  const [examDateDraft, setExamDateDraft] = useState(examDate ?? "");
  const [examDateBusy, setExamDateBusy] = useState(false);
  const [examDateError, setExamDateError] = useState<string | null>(null);
  const [sourcesUserOpen, setSourcesUserOpen] = useState(false);
  const [activeMode, setActiveMode] = useState<ViewKind>(initialMode);
  const [documentDraftDirty, setDocumentDraftDirty] = useState(false);
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [pendingDraftAction, setPendingDraftAction] = useState<PendingDraftAction | null>(null);
  const documentDraftControllerRef = useRef<LockedInDraftController | null>(null);
  const router = useRouter();
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

  const hasViews = useMemo(() => viewsExist(views), [views]);
  const hasCompleteViews = useMemo(
    () =>
      (["locked_in", "summary", "test_me", "carded"] as const).every(
        (kind) => Boolean(views[kind]),
      ),
    [views],
  );
  const sourcesExpanded = hasViews ? sourcesUserOpen : true;
  const examCountdown = currentExamDate
    ? examCountdownCopy(currentExamDate)
    : null;

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

  const generation = useGeneration({
    userId,
    reviewerId,
    onViews: applyGenerated,
    onCardsRefresh: () => {
      void fetch(`/api/reviewers/${reviewerId}/cards`)
        .then(async (response) => (response.ok ? (await response.json()) as { cards: SerializedCard[] } : null))
        .then((data) => {
          if (data) setCards(data.cards);
        })
        .catch(() => undefined);
    },
  });

  function protectedRevisionSnapshot() {
    return [
      ...(["locked_in", "summary", "test_me", "carded"] as const)
        .map((viewKind) => views[viewKind])
        .filter((view): view is NonNullable<typeof view> => Boolean(view))
        .flatMap((view) => [
          { key: `view:${view.kind}`, revision: view.revision },
          ...((view.annotations?.some((annotation) => !annotation.archivedAt))
            ? [{ key: `annotations:${view.kind}`, revision: view.annotationRevision }]
            : []),
        ]),
      ...cards.map((card) => ({ key: `card:${card.sourceKey}`, revision: card.revision })),
    ];
  }

  function startRedo(kind: ViewKind, forceOverwrite = false) {
    const request: GenerationRequest = {
      intent: "redo",
      kind,
      scope: kind === "locked_in" ? "full" : "selected",
      forceOverwrite,
      expectedProtected: protectedRevisionSnapshot(),
    };
    void generation.start(request);
  }

  function requestDraftAction(action: PendingDraftAction): boolean {
    if (!documentDraftDirty) return true;
    setPendingDraftAction(action);
    setDraftDialogOpen(true);
    return false;
  }

  function requestModeChange(kind: ViewKind): boolean {
    if (kind === activeMode) return true;
    if (!requestDraftAction({ type: "mode", kind })) return false;
    setActiveMode(kind);
    return true;
  }

  function requestRedo(kind: ViewKind, forceOverwrite: boolean): boolean {
    return requestDraftAction({ type: "redo", kind, forceOverwrite });
  }

  const historyGuardRef = useRef<DraftHistoryGuard | null>(null);

  const historyContinueRef = useRef(false);

  function performDraftAction(action: PendingDraftAction) {
    if (action.type === "mode") setActiveMode(action.kind);
    else if (action.type === "redo") startRedo(action.kind, action.forceOverwrite);
    else if (action.type === "history") historyGuardRef.current?.confirm();
    else router.push(action.href);
  }

  async function saveDraftAndContinue() {
    const saved = await documentDraftControllerRef.current?.save();
    if (saved !== true) return;
    const action = pendingDraftAction;
    historyContinueRef.current = true;
    setPendingDraftAction(null);
    setDraftDialogOpen(false);
    if (action) performDraftAction(action);
    setDocumentDraftDirty(false);
  }

  function discardDraftAndContinue() {
    documentDraftControllerRef.current?.discard();
    const action = pendingDraftAction;
    historyContinueRef.current = true;
    setPendingDraftAction(null);
    setDraftDialogOpen(false);
    if (action) performDraftAction(action);
    setDocumentDraftDirty(false);
  }

  useEffect(() => {
    if (!documentDraftDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [documentDraftDirty]);

  // The shell logo and topic shelf live above this client workspace and do not
  // know about its draft controller. Capture same-origin link clicks here so a
  // dirty Summary or Locked In draft gets the same Save/Discard/Cancel choice
  // as the in-workspace mode and breadcrumb controls.
  useEffect(() => {
    if (!documentDraftDirty) return;
    function guardShellNavigation(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!target || target.closest("[data-draft-guarded]")) return;
      const href = target.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      let url: URL;
      try { url = new URL(href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      setPendingDraftAction({ type: "href", href: `${url.pathname}${url.search}${url.hash}` });
      setDraftDialogOpen(true);
    }
    document.addEventListener("click", guardShellNavigation, true);
    return () => document.removeEventListener("click", guardShellNavigation, true);
  }, [documentDraftDirty]);

  useEffect(() => {
    if (!documentDraftDirty) {
      historyGuardRef.current?.dispose();
      historyGuardRef.current = null;
      return;
    }
    const guard = attachDraftHistoryGuard(
      {
        navigation: browserDraftNavigation(),
        supportsPrecommitHandler: browserSupportsPrecommitHandler(),
      },
      {
        isDirty: () => documentDraftDirty,
        onBlock(intent) {
          setPendingDraftAction(intent);
          setDraftDialogOpen(true);
        },
      },
    );
    historyGuardRef.current = guard;
    return () => {
      guard.dispose();
      if (historyGuardRef.current === guard) historyGuardRef.current = null;
    };
  }, [documentDraftDirty]);

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

  const sourcePanel = (
    <SourcePanel
      userId={userId}
      reviewerId={reviewerId}
      initialSources={initialSources}
      onSourcesChange={setSources}
      expanded={sourcesExpanded}
    />
  );

  const generateSection = (
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
      <GenerationControls
        state={generation.state}
        hasReadySource={hasReadySource}
        hasViews={hasViews}
        hasCompleteViews={hasCompleteViews}
        sourcesAreMediaOnly={sourcesAreMediaOnly}
        onGenerate={() => void generation.start({ intent: "generate_missing" })}
        onResume={() => void generation.resume()}
      />
      <GenerationStatus
        state={generation.state}
        onDismiss={generation.dismiss}
        onResume={() => void generation.resume()}
      />
    </section>
  );

  const studySection = (
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
        userId={userId}
        viewsLoading={viewsLoading}
        hasReadySource={hasReadySource}
        showRedo={hasViews}
        busy={generation.state.busy}
        cards={cards}
        examDate={currentExamDate}
        testAttemptStats={testAttemptStats}
        reviewerId={reviewerId}
        onCardsChange={setCards}
        onTestAttemptStatsChange={setTestAttemptStats}
        onViewsChange={setViews}
        onRedo={startRedo}
        onDraftDirtyChange={setDocumentDraftDirty}
        draftControllerRef={documentDraftControllerRef}
        onNavigateRequest={requestModeChange}
        onRedoRequest={requestRedo}
        compact
        value={activeMode}
        onValueChange={setActiveMode}
      />
    </section>
  );

  return (
    <div data-draft-guarded className={hasViews ? "flex flex-col gap-10" : "flex flex-col gap-8"}>
      <div className="space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <nav className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <Link
                href={`/?topic=${topicId}`}
                className="rounded outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
                onClick={(event) => {
                  if (!requestDraftAction({ type: "href", href: `/?topic=${topicId}` })) {
                    event.preventDefault();
                  }
                }}
              >
                {topicName}
              </Link>
              <span aria-hidden>/</span>
              <span className="text-foreground">{reviewerName}</span>
            </nav>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[1.75rem]">
                {reviewerName}
              </h1>
              {isClient && examCountdown ? (
                <p className="text-sm text-muted-foreground">{examCountdown}</p>
              ) : null}
            </div>
          </div>
          {hasViews ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={sourcesExpanded}
              aria-controls="sources-panel"
              onClick={() => setSourcesUserOpen((open) => !open)}
            >
              Sources
              {sourcesExpanded ? (
                <CaretUp weight="bold" />
              ) : (
                <CaretDown weight="bold" />
              )}
            </Button>
          ) : null}
        </div>
        <details className="mt-3 max-w-md rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-foreground" suppressHydrationWarning>
            {generatedLabel}. Exam date {currentExamDate ? `· ${currentExamDate}` : ""}
          </summary>
          <div className="flex flex-wrap items-end gap-2 pt-3">
            <label htmlFor="exam-date" className="grid gap-1 text-xs text-muted-foreground">
              Exam date
              <input id="exam-date" name="examDate" type="date" value={examDateDraft} onChange={(event) => setExamDateDraft(event.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground" />
            </label>
            <button type="button" className="h-9 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50" onClick={() => void saveExamDate()} disabled={examDateBusy || examDateDraft === (currentExamDate ?? "")}>
              {examDateBusy ? "Saving" : "Save date"}
            </button>
            {currentExamDate ? <p className="basis-full text-xs text-muted-foreground">Cards will be scheduled no later than this date.</p> : null}
            {examDateError ? <p role="alert" className="basis-full text-xs text-destructive">{examDateError}</p> : null}
          </div>
        </details>
      </div>

      {hasViews ? (
        <>
          {studySection}
          {sourcePanel}
          {generateSection}
        </>
      ) : (
        <>
          {sourcePanel}
          {generateSection}
          <Separator />
          {studySection}
        </>
      )}
      <Dialog
        open={draftDialogOpen}
        onOpenChange={(open) => {
          setDraftDialogOpen(open);
          if (!open) {
            if (!historyContinueRef.current) historyGuardRef.current?.cancel();
            historyContinueRef.current = false;
            setPendingDraftAction(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved study document changes</DialogTitle>
            <DialogDescription>
              Save this draft before leaving or redoing the study mode, discard it, or cancel to keep editing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { historyGuardRef.current?.cancel(); setDraftDialogOpen(false); setPendingDraftAction(null); }}>
              Cancel
            </Button>
            <Button type="button" variant="outline" onClick={discardDraftAndContinue}>
              Discard
            </Button>
            <Button type="button" onClick={() => void saveDraftAndContinue()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
