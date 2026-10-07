"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { ViewsPayload } from "@/lib/serialize-view";
import {
  SourcePanel,
  type SourceListItem,
} from "@/components/source-panel";
import { AskProvider } from "@/components/ask-provider";
import { FocusModeProvider } from "@/components/focus-mode";
import { ScrollJump } from "@/components/scroll-jump";
import { useSectionMastery } from "@/components/study-side-panel";
import { ViewTabs } from "@/components/view-tabs";
import { GenerationControls, type FreeRequestQuota } from "@/components/generation-controls";
import { GenerationStatus } from "@/components/generation-status";
import { MODE_KIT_ITEMS } from "@/components/mode-kit";
import type { ModeMenuItem } from "@/components/mode-toolbar";
import { PackReadyNotice } from "@/components/pack-ready-notice";
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
import { formatStamp } from "@/lib/format-generated-at";
import type { ViewKind } from "@/lib/types";
import { useIsClient } from "@/lib/use-is-client";
import { readApiError } from "@/lib/utils";
import { useGeneration } from "@/lib/use-generation";
import { useSourceVision } from "@/lib/use-source-vision";
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
  /** Answers saved to Notes from Ask, counted on the server so the Notes label is right before Ask loads. */
  savedAnswerCount?: number;
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
  createdAt: string;
  firstReviewedAt: string | null;
  isNew: boolean;
  nextIntervals: { again: { days: number }; good: { days: number } };
};

export type SerializedAttemptStats = {
  itemId: string;
  attempts: number;
  misses: number;
  lastAttemptedAt: string | null;
};

const MS_PER_DAY = 86_400_000;
const READING_SLIDES_NOTE =
  "Reading slide images first. Generate unlocks when it finishes.";

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
  savedAnswerCount = 0,
}: ReviewerWorkspaceProps) {
  const sectionMastery = useSectionMastery();
  const [sources, setSources] = useState(initialSources);
  const packSources = useMemo(
    () => sources.map((source) => ({ id: source.id, filename: source.filename, hasPageMarkers: source.hasPageMarkers })),
    [sources],
  );
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
  const [examDateOpen, setExamDateOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [activeMode, setActiveMode] = useState<ViewKind>(initialMode);
  const [documentDraftDirty, setDocumentDraftDirty] = useState(false);
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [pendingDraftAction, setPendingDraftAction] = useState<PendingDraftAction | null>(null);
  const documentDraftControllerRef = useRef<LockedInDraftController | null>(null);
  const router = useRouter();
  const isClient = useIsClient();
  // No time text in the server render: it does not know the viewer's zone.
  const generatedStamp = generatedAt && isClient ? formatStamp(generatedAt) : null;

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

  function refreshCards() {
    void fetch(`/api/reviewers/${reviewerId}/cards`)
      .then(async (response) => (response.ok ? (await response.json()) as { cards: SerializedCard[] } : null))
      .then((data) => {
        if (data) setCards(data.cards);
      })
      .catch(() => undefined);
  }

  // Hosted here, not in SourcePanel, so reading keeps going while the Sources
  // list is collapsed or the panel remounts when the layout switches.
  const vision = useSourceVision({ reviewerId, sources });
  const readingSlides = vision.reading;
  const busyReason = readingSlides ? READING_SLIDES_NOTE : null;
  // Pages the provider refused were settled with no readable content. Each
  // source row says which; the More item and the Sources dialog carry the total.
  const unreadablePages = sources.reduce((total, source) => {
    const entry = vision.progress[source.id];
    return entry && entry.state !== "reading" ? total + (entry.unreadable?.length ?? 0) : total;
  }, 0);

  const generation = useGeneration({
    userId,
    reviewerId,
    onViews: applyGenerated,
    onCardsRefresh: refreshCards,
  });

  // Free requests left today on the shared key. Read on mount, after each
  // finished step, and when a job ends; never on a timer.
  const [quota, setQuota] = useState<FreeRequestQuota | null>(null);
  const generationStatus = generation.state.status;
  const quotaRefreshKey = `${generation.state.job?.completedKinds.length ?? 0}:${
    generationStatus === "succeeded" || generationStatus === "failed" || generationStatus === "partial"
      ? generationStatus
      : ""
  }`;
  // The mount read may use the server's short cache; reads after progress
  // skip it, since requests were just spent.
  const initialQuotaKeyRef = useRef(quotaRefreshKey);
  useEffect(() => {
    let cancelled = false;
    const url = quotaRefreshKey === initialQuotaKeyRef.current ? "/api/quota" : "/api/quota?fresh=1";
    void fetch(url, { cache: "no-store" })
      .then(async (response) => (response.ok ? (await response.json()) as { remaining: number | null; limit: number | null } : null))
      .then((data) => {
        if (cancelled || !data) return;
        setQuota(data.remaining !== null && data.limit !== null ? { remaining: data.remaining, limit: data.limit } : null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [quotaRefreshKey]);

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
    if (busyReason) return;
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
    if (busyReason) return false;
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

  async function saveExamDate(next: string = examDateDraft) {
    setExamDateBusy(true);
    setExamDateError(null);
    try {
      const res = await fetch(`/api/reviewers/${reviewerId}/exam-date`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examDate: next || null }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { examDate: string | null };
      setCurrentExamDate(data.examDate);
      setExamDateDraft(data.examDate ?? "");
      setExamDateOpen(false);
    } catch (error) {
      setExamDateError(error instanceof Error ? error.message : "Could not save exam date.");
    } finally {
      setExamDateBusy(false);
    }
  }

  // Sources sit inline before the first generate, so the dialog entry only appears once views exist.
  const packMenuItems: ModeMenuItem[] = [
    ...(hasViews ? [{
      id: "sources",
      label: `Sources (${sources.length})`,
      hint: unreadablePages > 0
        ? unreadablePages === 1 ? "1 page unreadable" : `${unreadablePages} pages unreadable`
        : undefined,
      onSelect: () => setSourcesOpen(true),
    }] : []),
    {
      id: "exam-date",
      label: currentExamDate ? `Exam date: ${currentExamDate}` : "Set exam date",
      onSelect: () => setExamDateOpen(true),
    },
  ];

  // Client only: the countdown and the stamp depend on the viewer's clock and zone.
  const headerMeta = [
    isClient ? examCountdown : null,
    !generatedAt ? "Not generated yet" : generatedStamp ? `Generated ${generatedStamp}` : null,
  ].filter((item): item is string => Boolean(item));

  const sourcePanel = (
    <div data-focus-hide className="print-hide">
    <SourcePanel
      userId={userId}
      reviewerId={reviewerId}
      initialSources={sources}
      onSourcesChange={setSources}
      expanded
      vision={vision}
    />
    </div>
  );

  const generateSection = (
    <section data-focus-hide className="print-hide space-y-3" aria-labelledby="generate-heading">
      <div>
        <h2
          id="generate-heading"
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          Study pack
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {hasViews
            ? "Generate missing fills study modes that are not generated yet."
            : "Generate writes Locked In, Summary, Test Me, and Carded from your ingested sources."}
        </p>
      </div>
      <GenerationControls
        state={generation.state}
        hasReadySource={hasReadySource}
        hasViews={hasViews}
        hasCompleteViews={hasCompleteViews}
        sourcesAreMediaOnly={sourcesAreMediaOnly}
        busyReason={busyReason}
        quota={quota}
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
      <h2 id="views-heading" className="sr-only">
        Study modes
      </h2>
      {viewsError ? (
        <div className="print-hide flex flex-wrap items-center gap-2">
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
        busyReason={busyReason}
        quota={quota}
        cards={cards}
        examDate={currentExamDate}
        testAttemptStats={testAttemptStats}
        reviewerId={reviewerId}
        reviewerName={reviewerName}
        packSources={packSources}
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
        packMenuItems={packMenuItems}
      />
    </section>
  );

  // When views exist the generation section shows above the study only while it
  // has something to do; a finished job shows a short "ready" line instead.
  const generationState = generation.state;
  const jobVisible =
    !generationState.dismissed &&
    (["queued", "running", "failed", "partial"] as const).some((status) => status === generationState.status);
  const finishedJob = generationState.status === "succeeded" && !generationState.dismissed;
  const finishedRedoKind =
    generationState.job?.intent === "redo" && generationState.job.targetKinds.length === 1
      ? generationState.job.targetKinds[0]
      : null;
  const readyLabel = finishedRedoKind
    ? `${MODE_KIT_ITEMS.find((item) => item.kind === finishedRedoKind)?.label ?? "Pack"} ready`
    : "Pack ready";
  const generationNotice = finishedJob ? (
    <PackReadyNotice label={readyLabel} onDone={generation.dismiss} />
  ) : !hasCompleteViews || jobVisible ? (
    generateSection
  ) : null;

  const examDateDialog = (
    <Dialog
      open={examDateOpen}
      onOpenChange={(open) => {
        setExamDateOpen(open);
        if (open) {
          setExamDateDraft(currentExamDate ?? "");
          setExamDateError(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Exam date</DialogTitle>
          <DialogDescription>Cards will be scheduled no later than this date.</DialogDescription>
        </DialogHeader>
        <label htmlFor="exam-date" className="grid gap-1 text-xs text-muted-foreground">
          Exam date
          <input
            id="exam-date"
            name="examDate"
            type="date"
            value={examDateDraft}
            onChange={(event) => setExamDateDraft(event.target.value)}
            className="h-11 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          />
        </label>
        {examDateError ? <p role="alert" className="text-xs text-destructive">{examDateError}</p> : null}
        <DialogFooter>
          {currentExamDate ? (
            <Button
              type="button"
              variant="outline"
              disabled={examDateBusy}
              onClick={() => {
                setExamDateDraft("");
                void saveExamDate("");
              }}
            >
              Clear
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => void saveExamDate()}
            disabled={examDateBusy || examDateDraft === (currentExamDate ?? "")}
          >
            {examDateBusy ? "Saving" : "Save date"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const sourcesDialog = (
    <Dialog open={sourcesOpen} onOpenChange={setSourcesOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          {/* The panel shows its own "Sources" heading; the title names the dialog for assistive tech. */}
          <DialogTitle className="sr-only">Sources</DialogTitle>
          {unreadablePages > 0 ? (
            <DialogDescription id="sources-unreadable-hint">
              {unreadablePages === 1 ? "1 page unreadable" : `${unreadablePages} pages unreadable`}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {sourcePanel}
      </DialogContent>
    </Dialog>
  );

  return (
    <AskProvider reviewerId={reviewerId} sections={sectionMastery} initialSavedCount={savedAnswerCount} onCardCreated={refreshCards}>
    <FocusModeProvider>
    <div data-draft-guarded className={hasViews ? "flex flex-col gap-10" : "flex flex-col gap-8"}>
      <div data-focus-hide className="min-w-0 space-y-1">
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
          {headerMeta.length > 0 ? (
            <p className="text-sm text-muted-foreground">{headerMeta.join(" \u00b7 ")}</p>
          ) : null}
        </div>
      </div>

      {hasViews ? (
        <>
          {generationNotice}
          {studySection}
          {sourcesDialog}
        </>
      ) : (
        <>
          {sourcePanel}
          {generateSection}
          <Separator />
          {studySection}
        </>
      )}
      {examDateDialog}
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
    <ScrollJump />
    </FocusModeProvider>
    </AskProvider>
  );
}
