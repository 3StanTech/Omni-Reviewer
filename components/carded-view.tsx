"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  CaretLeft,
  CaretRight,
  Cards,
  DotsThree,
  DownloadSimple,
  Eye,
  EyeSlash,
  FileText,
  PencilSimple,
  PushPin,
  Question,
  Star,
} from "@phosphor-icons/react";

import { ExplainThisButton } from "@/components/ask-provider";
import { useCardExport } from "@/components/card-export";
import { EmptyState } from "@/components/empty-state";
import { FirstCelebration, useFirstCelebration } from "@/components/first-celebration";
import { KirbyCompanion, type KirbyReaction } from "@/components/kirby-companion";
import { useSourceViewer } from "@/components/source-modal";
import { SittingRecap } from "@/components/sitting-recap";
import { StudyHelp } from "@/components/study-help";
import { MarkdownBody } from "@/components/study-markdown";
import { firstPageCitation } from "@/components/timed-test-me";
import { WarpStar } from "@/components/kirby-art";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { stripCitations } from "@/lib/citations";
import { parseCardedItems } from "@/lib/learning";
import { isClozeCardFront, renderClozeText } from "@/lib/learning";
import { kirbyHat, type KirbyHatId } from "@/lib/kirby-hat";
import {
  captureDueQueue,
  type CapturedCard,
  practiceQueue,
  reconcileDueSession,
} from "@/lib/practice-session";
import { dueLabel, selectTodayCards } from "@/lib/pacing";
import { formatSittingDuration, nextReturnCopy, recapFocusSection } from "@/lib/sitting-recap";
import { isStudyKeyTarget } from "@/lib/study-keys";
import { dueSplitCopy } from "@/lib/today-plan";
import type { CardedItem } from "@/lib/types";
import { cn, readApiError } from "@/lib/utils";

type DurableCardView = CardedItem & {
  sourceKey: string;
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

type CardedViewProps = {
  contentJson: unknown | null;
  content: string | null;
  reviewerId: string;
  durableCards: DurableCardView[];
  examDate?: string | null;
  onCardsChange: (cards: DurableCardView[]) => void;
  /** Locked In markdown; names the most-missed section in the recap. */
  lockedIn?: string | null;
  /** Pack name, used for card export filenames. */
  reviewerName?: string;
};

function parseCards(
  contentJson: unknown | null,
  content: string | null,
): CardedItem[] {
  return parseCardedItems(contentJson, content ?? "");
}

function isDurableCard(value: CardedItem | DurableCardView | null | undefined): value is DurableCardView {
  return value != null && "revision" in value && typeof value.revision === "number";
}

/** Chips inside a face act on their own; they must never flip the card. */
function isInteractiveInsideFace(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest("button, a, [data-cite-source]"));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's paced queue: the same `selectTodayCards` the pack row counts with. */
function todayCards(cards: DurableCardView[], examDate: string | null, nowMs: number) {
  const now = new Date(nowMs);
  const introducedLast24h = cards.filter((card) => {
    const first = card.firstReviewedAt ? new Date(card.firstReviewedAt).getTime() : NaN;
    return Number.isFinite(first) && first > nowMs - DAY_MS;
  }).length;
  return selectTodayCards(
    cards.map((card) => ({
      id: card.id,
      dueAt: new Date(card.dueAt),
      createdAt: new Date(card.createdAt),
      isNew: card.isNew,
      card,
    })),
    { examDate, introducedLast24h, now },
  ).map((entry) => entry.card);
}

function reactionFor(rating: "again" | "good"): KirbyReaction {
  return { outcome: rating === "good" ? "happy" : "sad", key: Date.now() };
}

/**
 * A recap with Kirby in Dream Land: above it on phones, a right column from 640px.
 * The last rating's reaction plays when the recap mounts. Day and Night render the recap alone.
 */
function WithKirby({
  reaction,
  hat,
  children,
}: {
  reaction: KirbyReaction | null;
  hat: KirbyHatId;
  children: ReactNode;
}) {
  return (
    <div className="dreamland:flex dreamland:flex-col dreamland:gap-2 dreamland:sm:flex-row-reverse dreamland:sm:items-start dreamland:sm:gap-[18px]">
      <KirbyCompanion size="md" reaction={reaction} hat={hat} className="shrink-0 max-sm:w-16 max-sm:self-end" />
      <div className="min-w-0 dreamland:sm:flex-1">{children}</div>
    </div>
  );
}

/** "today", "tomorrow" or "in N days". */
function dayCopy(days: number) {
  if (days <= 0) return "today";
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

/** "Back today", "Back tomorrow" or "Back in N days": when a rated card returns. */
function intervalCopy(days: number) {
  return `Back ${dayCopy(days)}`;
}

/** A keycap, shown on fine pointers only. */
function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="hidden h-5 min-w-5 place-items-center rounded-md border border-current px-[5px] font-mono text-[11px] font-semibold opacity-70 pointer-fine:inline-grid">
      {children}
    </kbd>
  );
}

/** Card toolbar icon button: 34px on fine pointers, 44px on touch. */
const CARD_TOOL_CLASS = "size-[34px] min-h-[34px] min-w-[34px] text-muted-foreground pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/** A due rating button with its return date in a tooltip on hover and keyboard focus. */
function RateButton({
  days,
  onRate,
  disabled,
  variant,
  children,
}: {
  days: number;
  onRate: () => void;
  disabled: boolean;
  variant: "outline" | "default";
  children: ReactNode;
}) {
  const back = intervalCopy(days);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<Button type="button" variant={variant} className={RATE_BUTTON_CLASS} disabled={disabled} />}
        onClick={onRate}
      >
        {children}
        <span className="sr-only">, {back.charAt(0).toLowerCase() + back.slice(1)}</span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={10} className="z-50">
          <Tooltip.Popup className="flex items-center gap-1 rounded-[10px] bg-foreground px-3 py-[7px] text-[13px] whitespace-nowrap text-background shadow-[0_6px_18px_rgb(74_34_54/18%)]">
            <Star weight="fill" aria-hidden className="size-3.5 text-[#ffd84a]" />
            {back}
            <Tooltip.Arrow className="carded-pop-arrow" />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Again and Good: 46px with keycaps on desktop, full-width halves of the phone thumb bar. */
const RATE_BUTTON_CLASS = "h-[46px] min-w-[150px] gap-2.5 px-5 text-[15px] max-sm:min-w-0";

export function CardedView({
  contentJson,
  content,
  reviewerId,
  durableCards,
  examDate = null,
  onCardsChange,
  lockedIn = null,
  reviewerName = "Pack",
}: CardedViewProps) {
  const generatedCards = useMemo(
    () => parseCards(contentJson, content),
    [contentJson, content],
  );
  const cards = durableCards.length > 0 ? durableCards : generatedCards;
  // Remaining due is the paced selection at dueAt <= now, so the cutoff has to be wall clock.
  /* eslint-disable react-hooks/purity -- dueAt <= now needs Date.now */
  const remaining = useMemo(() => {
    const due = todayCards(durableCards, examDate, Date.now());
    const fresh = due.filter((item) => item.isNew).length;
    return { review: due.length - fresh, fresh };
  }, [durableCards, examDate]);
  /* eslint-enable react-hooks/purity */
  // Practice replays this session's cards without saving ratings or changing schedules.
  const [mode, setMode] = useState<"due" | "browse" | "practice">("due");
  const [queue, setQueue] = useState<CapturedCard[]>(() => {
    const now = Date.now();
    return captureDueQueue(todayCards(durableCards, examDate, now), now);
  });
  const [ratedIds, setRatedIds] = useState<string[]>([]);
  const [tally, setTally] = useState({ again: 0, good: 0 });
  const [againIds, setAgainIds] = useState<string[]>([]);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => Date.now());
  // Set when a rating saves, so the recap duration stops at the last rating.
  const [lastRatedAt, setLastRatedAt] = useState<number | null>(null);
  const [practiceCaptured, setPracticeCaptured] = useState<CapturedCard[]>([]);
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [practiceTally, setPracticeTally] = useState({ again: 0, good: 0 });
  const [practiceAgainIds, setPracticeAgainIds] = useState<string[]>([]);
  const [browseIndex, setBrowseIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [clozeRevealed, setClozeRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [frontDraft, setFrontDraft] = useState("");
  const [backDraft, setBackDraft] = useState("");
  const [draftCardId, setDraftCardId] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduleHint, setScheduleHint] = useState<string | null>(null);
  // Kirby's latest rating reaction (Dream Land only); cleared when a new round starts.
  const [kirby, setKirby] = useState<KirbyReaction | null>(null);
  // The pack's copy hat on every Carded Kirby (Dream Land only).
  const hat = kirbyHat(reviewerId);
  const sourceViewer = useSourceViewer();
  // Phone toast after a saved rating: "Back in 28 days" (coarse pointers only, never in practice).
  const [toast, setToast] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const optionsTrigger = useRef<HTMLButtonElement>(null);
  const dueId = useId();
  const openingHelp = useRef(false);
  const cardExport = useCardExport(cards, reviewerName);
  const advanceTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);
  const reviewEpoch = useRef(0);
  const requestIds = useRef(new Map<string, string>());
  // Bumped whenever a round starts or the toast is cleared, so a late response cannot bring back an old round's toast.
  // State (not a ref write) so the round switchers stay pure; the ref mirrors it for the async review handler.
  const [toastRoundState, setToastRound] = useState(0);
  const toastRound = useRef(0);
  // False after unmount: a late review response then skips its UI effects and timers.
  const mounted = useRef(true);

  useEffect(() => {
    toastRound.current = toastRoundState;
  }, [toastRoundState]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  function clearToast() {
    setToastRound((round) => round + 1);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(null);
  }

  function showToast(text: string) {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 2200);
  }

  function captureQueue() {
    const now = Date.now();
    setQueue(captureDueQueue(todayCards(durableCards, examDate, now), now));
    setRatedIds([]);
    setTally({ again: 0, good: 0 });
    setAgainIds([]);
    setSessionStartedAt(now);
    setLastRatedAt(null);
    setKirby(null);
    setFlipped(false);
    setClozeRevealed(false);
    setScheduleHint(null);
    setError(null);
  }

  const ratedSet = useMemo(() => new Set(ratedIds), [ratedIds]);
  const dueSession = useMemo(
    () => reconcileDueSession({
      queue,
      cards: durableCards,
      ratedIds: ratedSet,
    }),
    [durableCards, queue, ratedSet],
  );

  // A due session that rated at least one card; the server then says whether anything is still due today.
  const firstAllDue = useFirstCelebration("all-due", mode === "due" && dueSession.finished && dueSession.completed > 0);
  const browsing = mode === "browse";
  const practicing = mode === "practice";
  const cardById = useMemo(() => new Map(durableCards.map((item) => [item.id, item])), [durableCards]);
  // Practice shows each card's latest content; a card deleted meanwhile drops out.
  const practiceCards = useMemo(
    () => practiceCaptured.flatMap((entry) => cardById.get(entry.id) ?? []),
    [cardById, practiceCaptured],
  );
  const practiceDone = practicing && practiceIndex >= practiceCards.length;
  const browseCards = durableCards.length > 0 ? durableCards : generatedCards;
  const safeBrowseIndex = Math.min(browseIndex, Math.max(0, browseCards.length - 1));
  const currentDue = dueSession.current?.card ?? null;
  const card = browsing
    ? browseCards[safeBrowseIndex] ?? null
    : practicing
      ? practiceCards[practiceIndex] ?? null
      : currentDue;
  const dueStale = mode === "due" && Boolean(dueSession.current?.stale);
  const isCloze = Boolean(card && (card.kind === "cloze" || isClozeCardFront(card.front)));
  const draftIsStale =
    editing &&
    (!isDurableCard(card) || draftCardId !== card.id || draftRevision !== card.revision);

  const packEmpty = cards.length === 0;

  function enterBrowse() {
    clearToast();
    setMode("browse");
    setBrowseIndex(0);
    setFlipped(false);
    setClozeRevealed(false);
    setScheduleHint(null);
    setError(null);
    setKirby(null);
  }

  function enterDue() {
    // clearToast, inlined: the React Compiler reads a helper call here as render-time, which flags captureQueue's Date.now.
    setToastRound((round) => round + 1);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(null);
    setMode("due");
    captureQueue();
  }



  function enterPractice(cardsToPractice: CapturedCard[]) {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    advanceTimer.current = null;
    clearToast();
    setMode("practice");
    setPracticeCaptured(cardsToPractice);
    setPracticeIndex(0);
    setPracticeTally({ again: 0, good: 0 });
    setPracticeAgainIds([]);
    setKirby(null);
    setFlipped(false);
    setClozeRevealed(false);
    setEditing(false);
    setScheduleHint(null);
    setError(null);
  }

  /** Practice rating: counts locally and moves on. Never saved, so schedules stay as they are. */
  function practiceRate(rating: "again" | "good") {
    if (!practicing || !card) return;
    setPracticeTally((current) => ({ ...current, [rating]: current[rating] + 1 }));
    if (rating === "again") {
      setPracticeAgainIds((current) => current.includes(card.id) ? current : [...current, card.id]);
    }
    setKirby(reactionFor(rating));
    setPracticeIndex((index) => index + 1);
    setFlipped(false);
    setClozeRevealed(false);
  }

  function go(delta: number) {
    if (!browsing) return;
    setFlipped(false);
    setClozeRevealed(false);
    setScheduleHint(null);
    setBrowseIndex((prev) => {
      const next = prev + delta;
      if (next < 0) return 0;
      if (next >= browseCards.length) return browseCards.length - 1;
      return next;
    });
  }

  function toggleFlip() {
    if (busy || scheduleHint || dueStale) return;
    setFlipped((open) => !open);
  }

  async function review(rating: "again" | "good") {
    // Practice never saves a rating.
    if (practicing) return;
    if (browsing || !card || !isDurableCard(card) || busy || dueStale) return;
    const expectedRevision = dueSession.current?.stale
      ? dueSession.current.capturedRevision
      : card.revision;
    if (dueSession.current && card.revision !== dueSession.current.capturedRevision) {
      setError("This card changed. Start a new due session before rating it.");
      return;
    }
    const requestId = requestIds.current.get(card.id) ?? crypto.randomUUID();
    requestIds.current.set(card.id, requestId);
    const epoch = ++reviewEpoch.current;
    const round = toastRound.current;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/cards/${card.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision,
          rating,
          clientRequestId: requestId,
        }),
      });
      // A saved rating still reaches the parent after unmount; only local UI waits on mounted below.
      if (epoch !== reviewEpoch.current) return;
      if (!response.ok) throw new Error(await readApiError(response));
      // A replayed request reports the rating its first attempt saved, which may differ from this tap.
      const data = (await response.json()) as { card: DurableCardView; rating: "again" | "good" };
      const saved = data.rating;
      onCardsChange(durableCards.map((item) => item.id === data.card.id ? data.card : item));
      if (!mounted.current) return;
      setRatedIds((current) => current.includes(card.id) ? current : [...current, card.id]);
      setTally((current) => ({ ...current, [saved]: current[saved] + 1 }));
      if (saved === "again") setAgainIds((current) => current.includes(card.id) ? current : [...current, card.id]);
      setLastRatedAt(Date.now());
      setKirby(reactionFor(saved));
      requestIds.current.delete(card.id);
      setScheduleHint(`Next review ${dayCopy(data.card.intervalDays)}`);
      if (round === toastRound.current) showToast(intervalCopy(data.card.intervalDays));
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
      advanceTimer.current = window.setTimeout(() => {
        if (epoch !== reviewEpoch.current) return;
        setScheduleHint(null);
        setFlipped(false);
        setClozeRevealed(false);
        advanceTimer.current = null;
      }, 700);
    } catch (caught) {
      if (!mounted.current || epoch !== reviewEpoch.current) return;
      setError(caught instanceof Error ? caught.message : "Could not save review.");
    } finally {
      if (mounted.current && epoch === reviewEpoch.current) setBusy(false);
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isStudyKeyTarget(event)) return;
      if (!card || editing || busy || dueStale) return;
      // A focused control inside Carded owns Space (Tab to Good, then Space grades); arrows still step.
      // Controls outside (the tab trigger, header, Focus toggle) must not block the flip.
      const control = event.target instanceof Element
        ? event.target.closest("button, a, [role='button'], summary")
        : null;
      if (event.key === " " && control?.closest("[data-carded-root]")) return;
      // A focused tab list already moves between modes on the arrows.
      if (event.target instanceof Element && event.target.closest("[role='tab']") && event.key !== " ") return;
      if (event.key === " ") {
        event.preventDefault();
        toggleFlip();
        return;
      }
      if (browsing) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          go(-1);
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          go(1);
        }
        return;
      }
      // Grading needs a saved card; generated cards only flip.
      if (!flipped || !isDurableCard(card)) return;
      if (practicing) {
        if (event.key === "1") practiceRate("again");
        if (event.key === "2") practiceRate("good");
        return;
      }
      if (event.key === "1") void review("again");
      if (event.key === "2") void review("good");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // review, practiceRate, go and toggleFlip are recreated each render; the listener only needs the latest closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsing, practicing, browseCards.length, busy, card, dueStale, editing, flipped, scheduleHint]);

  async function saveEdit() {
    if (!isDurableCard(card)) return;
    if (draftIsStale) {
      setFrontDraft(card.front);
      setBackDraft(card.back);
      setDraftCardId(card.id);
      setDraftRevision(card.revision);
      setEditing(false);
      setError("This card changed elsewhere. Reload the latest card before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/cards/${card.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: draftRevision, front: frontDraft, back: backDraft }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { card: DurableCardView };
      onCardsChange(durableCards.map((item) => item.id === data.card.id ? data.card : item));
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save card.");
    } finally {
      setBusy(false);
    }
  }

  async function togglePin() {
    if (!isDurableCard(card)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/cards/${card.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: card.revision, pinned: !card.isPinned }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { card: DurableCardView };
      onCardsChange(durableCards.map((item) => item.id === data.card.id ? data.card : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not pin card.");
    } finally {
      setBusy(false);
    }
  }

  // Citations belong to the answer side only.
  const frontSource = stripCitations(
    card && isCloze && !clozeRevealed ? renderClozeText(card.front) : card?.front ?? "",
  );
  const backCitation = card && flipped ? firstPageCitation([card.back]) : null;
  const backPage = backCitation?.pageStart ?? null;

  const recapEndedAt = lastRatedAt ?? sessionStartedAt;
  const recapFocus = dueSession.finished
    ? recapFocusSection({
        lockedIn,
        missedTexts: againIds.flatMap((id) => cardById.get(id)?.back ?? []),
      })?.title ?? null
    : null;
  const recapReturns = dueSession.finished
    ? nextReturnCopy(ratedIds.flatMap((id) => cardById.get(id)?.dueAt ?? []), new Date(recapEndedAt))
    : null;

  const remainingCopy = dueSplitCopy(remaining.review, remaining.fresh) || "none";

  /** Practice missed (hidden when none) and Practice all for a finished round; after practice, Back to due too. */
  function practiceButtons(captured: CapturedCard[], missedIds: string[], afterPractice = false) {
    const missed = practiceQueue({ queue: captured, againIds: missedIds, which: "missed" })
      .filter((entry) => cardById.has(entry.id));
    const all = practiceQueue({ queue: captured, againIds: missedIds, which: "all" })
      .filter((entry) => cardById.has(entry.id));
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        {missed.length > 0 ? (
          <Button type="button" variant="outline" onClick={() => enterPractice(missed)}>
            Practice missed ({missed.length})
          </Button>
        ) : null}
        {all.length > 0 ? (
          <Button type="button" variant="outline" onClick={() => enterPractice(all)}>
            Practice all ({all.length})
          </Button>
        ) : null}
        {afterPractice ? (
          <Button type="button" variant="ghost" onClick={enterDue}>
            Back to due
          </Button>
        ) : null}
      </div>
    );
  }

  if (packEmpty) {
    return (
      <EmptyState
        icon={<Cards weight="duotone" className="size-5" />}
        title="Carded is empty"
        description="Generate the pack to build flashcards from the Summary. Flip a card, then step previous or next."
      />
    );
  }

  const sessionLabel = browsing
    ? `Browsing ${browseCards.length === 0 ? 0 : safeBrowseIndex + 1} of ${browseCards.length}`
    : practicing
      ? `Practice ${Math.min(practiceIndex + 1, practiceCards.length)} of ${practiceCards.length}`
      : dueSession.empty
      ? "0 of 0 due"
      : `${dueSession.completed} of ${dueSession.total}`;
  const showProgress = mode === "due" && !dueSession.empty;
  const due = isDurableCard(card) ? dueLabel(new Date(card.dueAt), new Date(sessionStartedAt)) : null;
  const cardTools = (isDurableCard(card) && (!practicing || flipped))
    || (backCitation !== null && backPage !== null && sourceViewer.available);
  const progressPercent = dueSession.total > 0 ? Math.round((dueSession.completed / dueSession.total) * 100) : 0;

  return (
    <div data-carded-root className="mx-auto flex w-full max-w-lg flex-col gap-4 dreamland:sm:max-w-[40rem]">
      {/* Session row: progress on the left, Browse all or Study due and the options menu on the right. */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 text-sm text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-3 max-md:basis-full">
          {showProgress ? (
            <>
              <span aria-hidden className="font-semibold text-foreground tabular-nums">
                {dueSession.completed} / {dueSession.total}
              </span>
              <div
                role="progressbar"
                aria-label="Session progress"
                aria-valuemin={0}
                aria-valuemax={dueSession.total}
                aria-valuenow={dueSession.completed}
                aria-valuetext={sessionLabel}
                className="relative h-2.5 min-w-[60px] flex-1 rounded-full bg-muted dreamland:ml-3.5 dreamland:bg-[#f6dfe7]"
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-primary dreamland:bg-[linear-gradient(90deg,#ff8fb4,#c2185b)]"
                  style={{ width: `${progressPercent}%` }}
                />
                {/* Dream Land: a Warp Star rides the head of the fill. */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 hidden w-[34px] -translate-x-[60%] -translate-y-1/2 print-hide dreamland:block"
                  style={{ left: `${progressPercent}%` }}
                >
                  <WarpStar trail={false} />
                </span>
              </div>
            </>
          ) : (
            <span className="font-semibold text-foreground tabular-nums">{sessionLabel}</span>
          )}
          {practicing ? (
            <span className="carded-pill">Practice, not scheduled</span>
          ) : mode === "due" && remainingCopy !== "none" ? (
            <span className="carded-pill">
              <Cards weight="bold" aria-hidden className="size-3.5" />
              {remainingCopy}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 max-md:ml-auto">
          {browsing || practicing ? (
            <Button type="button" variant="ghost" size="sm" onClick={enterDue}>
              Study due
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={enterBrowse}>
              <Eye weight="bold" />
              Browse all
            </Button>
          )}
          <div className="relative inline-flex">
            <DropdownMenu>
              <DropdownMenuTrigger
                ref={optionsTrigger}
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="print-hide pointer-coarse:size-11"
                    aria-label="Carded options"
                    title="Carded options"
                  />
                }
              >
                <DotsThree weight="bold" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-auto min-w-60"
                finalFocus={() => {
                  // Opening "How cards come back" moves focus into its panel; the menu must not take it back.
                  if (!openingHelp.current) return true;
                  openingHelp.current = false;
                  return false;
                }}
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Export cards</DropdownMenuLabel>
                  {cardExport.options.map((option) => (
                    <DropdownMenuItem
                      key={option.kind}
                      disabled={option.count === 0}
                      onClick={() => cardExport.exportKind(option.kind)}
                    >
                      <DownloadSimple weight="bold" aria-hidden />
                      <span className="flex flex-col">
                        <span>{option.label}</span>
                        {option.count === 0 ? <span className="text-xs text-muted-foreground">{option.empty}</span> : null}
                      </span>
                      <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{option.count}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    openingHelp.current = true;
                    setHelpOpen(true);
                  }}
                >
                  <Question weight="bold" aria-hidden />
                  How cards come back
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <StudyHelp open={helpOpen} onOpenChange={setHelpOpen} anchorRef={optionsTrigger} className="absolute top-full right-0" />
          </div>
        </div>
      </div>
      {mode === "due" && dueSession.empty ? (
        <EmptyState
          icon={<Cards weight="duotone" className="size-5" />}
          title="No cards due"
          description="Nothing is due in this session. Browse all to inspect cards without scheduling, or start again later."
        />
      ) : null}
      {mode === "due" && dueSession.finished && firstAllDue.show ? (
        <FirstCelebration
          kind="all-due"
          onDone={firstAllDue.dismiss}
          onShow={() => setKirby({ outcome: "dance", key: Date.now() })}
        />
      ) : null}
      {mode === "due" && dueSession.finished ? (
        // A finished due session with a saved rating ends in the victory dance (Dream Land only).
        <WithKirby
          reaction={kirby && dueSession.completed > 0 ? { outcome: "dance", key: kirby.key } : kirby}
          hat={hat}
        >
          <SittingRecap
            title="Session complete"
            lines={[
              `${dueSession.completed} cards · ${tally.good} Good · ${tally.again} Again`,
              `Studied for ${formatSittingDuration(recapEndedAt - sessionStartedAt)}`,
            ]}
            focusSection={recapFocus}
            returns={recapReturns}
          >
            <p className="text-sm text-muted-foreground">Newly due cards wait for the next session.</p>
            {practiceButtons(queue, againIds)}
          </SittingRecap>
        </WithKirby>
      ) : null}
      {practiceDone ? (
        <WithKirby reaction={kirby} hat={hat}>
          <SittingRecap
            title="Practice done"
            lines={[
              `${practiceCards.length} cards · ${practiceTally.good} Good · ${practiceTally.again} Again`,
              "Practice ratings are not saved. Schedules did not change.",
            ]}
          >
            {practiceButtons(practiceCaptured, practiceAgainIds, true)}
          </SittingRecap>
        </WithKirby>
      ) : null}

      {isDurableCard(card) && (card.isEdited || card.isPinned || dueStale) ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-warning">
          {card.isEdited || card.isPinned ? <span>Protected from silent overwrite</span> : null}
          {dueStale ? <span>This card changed. Start a new due session before rating it.</span> : null}
        </div>
      ) : null}

      {card && isCloze ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setClozeRevealed((open) => !open)}
            aria-pressed={clozeRevealed}
          >
            {clozeRevealed ? <EyeSlash weight="bold" /> : <Eye weight="bold" />}
            {clozeRevealed ? "Hide blanks" : "Reveal blanks"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Fill the blanks before revealing the answers.
          </span>
        </div>
      ) : null}

      {card ? (
      <div className="dreamland:relative dreamland:sm:flex dreamland:sm:items-start dreamland:sm:gap-[18px]">
        <div className="carded-scene relative min-w-0 dreamland:max-sm:mr-16 dreamland:sm:flex-1">
          <div
            role="button"
            tabIndex={0}
            onClick={toggleFlip}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleFlip();
              }
            }}
            className={cn(
              "carded-flipper group outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
              flipped && "is-flipped",
            )}
            aria-label="Flip"
            aria-describedby={due ? dueId : undefined}
            aria-pressed={flipped}
          >
            <div className="carded-face carded-front">
              <span className="mb-3 inline-flex items-center gap-2.5">
                <span className="text-[0.65rem] font-semibold tracking-[0.14em] text-muted-foreground uppercase">Front</span>
                {due ? <span aria-hidden className="carded-due">{due}</span> : null}
              </span>
              <MarkdownBody source={frontSource} />
              <span className="mt-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground">Flip<Keycap>Space</Keycap></span>
            </div>
            <div
              className="carded-face carded-back"
              inert={!flipped}
              onClick={(event) => {
                if (isInteractiveInsideFace(event.target)) event.stopPropagation();
              }}
              onKeyDown={(event) => {
                if (isInteractiveInsideFace(event.target)) event.stopPropagation();
              }}
            >
              <span className="mb-3 inline-flex items-center gap-2.5">
                <span className="text-[0.65rem] font-semibold tracking-[0.14em] text-muted-foreground uppercase">Back</span>
                {due ? <span aria-hidden className="carded-due">{due}</span> : null}
              </span>
              <MarkdownBody source={card.back} />
              <span className="mt-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground">Flip<Keycap>Space</Keycap></span>
            </div>
          </div>
          {due ? <span id={dueId} className="sr-only">{due}</span> : null}
          {/* Card tools sit on the card's corner, outside the flip target: top-right, top-left on phones so Kirby keeps the right. */}
          {cardTools ? (
            <div className="print-hide absolute top-3 right-3 z-10 flex gap-0.5 max-sm:top-2 max-sm:right-auto max-sm:left-2">
              {isDurableCard(card) && !practicing ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={CARD_TOOL_CLASS}
                  aria-label={editing ? "Cancel edit" : "Edit card"}
                  title={editing ? "Cancel edit" : "Edit card"}
                  disabled={busy}
                  onClick={() => {
                    if (!editing) {
                      setFrontDraft(card.front);
                      setBackDraft(card.back);
                      setDraftCardId(card.id);
                      setDraftRevision(card.revision);
                    }
                    setEditing((open) => !open);
                  }}
                >
                  <PencilSimple weight="bold" aria-hidden />
                </Button>
              ) : null}
              {isDurableCard(card) && !practicing ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(CARD_TOOL_CLASS, card.isPinned && "text-primary")}
                  aria-label={card.isPinned ? "Unpin card" : "Pin card"}
                  title={card.isPinned ? "Unpin card" : "Pin card"}
                  disabled={busy}
                  onClick={() => void togglePin()}
                >
                  <PushPin weight={card.isPinned ? "fill" : "bold"} aria-hidden />
                </Button>
              ) : null}
              {isDurableCard(card) && flipped ? (
                <ExplainThisButton
                  iconOnly
                  className={CARD_TOOL_CLASS}
                  request={{ kind: "explain", target: { type: "card", cardId: card.id } }}
                />
              ) : null}
              {backCitation && backPage !== null && sourceViewer.available ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={CARD_TOOL_CLASS}
                  aria-label={`Open source, page ${backPage}`}
                  title={`Open source, page ${backPage}`}
                  onClick={() => sourceViewer.openSource({
                    source: backCitation.source,
                    page: backPage,
                    pageEnd: backCitation.pageEnd,
                    claim: stripCitations(card.back).trim() || null,
                  })}
                >
                  <FileText weight="bold" aria-hidden />
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <KirbyCompanion
          size="md"
          reaction={kirby}
          hat={hat}
          className="shrink-0 max-sm:absolute max-sm:top-0 max-sm:right-0 max-sm:w-16 sm:sticky sm:top-[120px]"
        />
      </div>
      ) : null}

      {browsing ? (
      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => go(-1)}
          disabled={safeBrowseIndex === 0}
          title="Previous (←)"
        >
          <CaretLeft weight="bold" />
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => go(1)}
          disabled={safeBrowseIndex >= browseCards.length - 1}
          title="Next (→)"
        >
          Next
          <CaretRight weight="bold" />
        </Button>
      </div>
      ) : null}

      {card && editing ? (
        <div className="space-y-2 rounded-xl border border-border/80 bg-surface/50 p-4">
          <label className="grid gap-1 text-xs text-muted-foreground">Front<textarea value={frontDraft} onChange={(event) => setFrontDraft(event.target.value)} className="min-h-20 rounded-md border border-border bg-background p-2 text-sm text-foreground" /></label>
          <p className="text-xs text-muted-foreground">Use balanced {"{{answer}}"} placeholders for a cloze card.</p>
          <label className="grid gap-1 text-xs text-muted-foreground">Back<textarea value={backDraft} onChange={(event) => setBackDraft(event.target.value)} className="min-h-20 rounded-md border border-border bg-background p-2 text-sm text-foreground" /></label>
          <Button type="button" onClick={() => void saveEdit()} disabled={busy || !frontDraft.trim() || !backDraft.trim()}>{busy ? "Saving" : "Save card"}</Button>
        </div>
      ) : null}
      {!browsing && isDurableCard(card) && !flipped && !dueStale ? (
        <div className="carded-thumb-bar sm:hidden">
          <Button type="button" variant="outline" className="w-full" onClick={toggleFlip} disabled={busy}>
            Show answer
          </Button>
        </div>
      ) : null}
      {!browsing && isDurableCard(card) && flipped && !dueStale ? (
        <div className="carded-thumb-bar flex items-center justify-center gap-2.5 py-1.5">
          {practicing ? (
            <>
              <Button type="button" variant="outline" className={RATE_BUTTON_CLASS} onClick={() => practiceRate("again")}>
                Again
              </Button>
              <Button type="button" className={RATE_BUTTON_CLASS} onClick={() => practiceRate("good")}>
                Good
              </Button>
            </>
          ) : scheduleHint ? (
            <p className="w-full text-center text-sm text-foreground">{scheduleHint}</p>
          ) : (
            <>
              <RateButton
                variant="outline"
                days={card.nextIntervals.again.days}
                disabled={busy}
                onRate={() => void review("again")}
              >
                Again
                <Keycap>1</Keycap>
              </RateButton>
              <RateButton
                variant="default"
                days={card.nextIntervals.good.days}
                disabled={busy}
                onRate={() => void review("good")}
              >
                Good
                <Keycap>2</Keycap>
              </RateButton>
            </>
          )}
        </div>
      ) : null}
      <div role="status" className="carded-toast print-hide">
        {toast && mode === "due" ? (
          <>
            <Star weight="fill" aria-hidden className="size-4 text-[#ffd84a]" />
            {toast}
          </>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <style>{`
        .carded-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 28px;
          padding: 0 12px;
          border-radius: 999px;
          background: var(--secondary);
          color: var(--secondary-foreground);
          font-size: 13px;
          font-weight: 500;
          white-space: nowrap;
        }
        .carded-due {
          display: inline-flex;
          align-items: center;
          height: 24px;
          padding: 0 10px;
          border-radius: 999px;
          background: color-mix(in oklch, var(--warning) 15%, transparent);
          color: var(--warning);
          font-size: 12px;
          font-weight: 500;
          white-space: nowrap;
        }
        [data-look="dreamland"] .carded-due {
          background: #fff3c4;
          color: #7a4d00;
        }
        .carded-pop-arrow {
          width: 12px;
          height: 6px;
          bottom: -6px;
          background: var(--foreground);
          clip-path: polygon(0 0, 100% 0, 50% 100%);
        }
        .carded-toast {
          display: none;
        }
        .carded-toast:not(:empty) {
          position: fixed;
          left: 50%;
          bottom: calc(104px + env(safe-area-inset-bottom));
          z-index: 40;
          display: flex;
          align-items: center;
          gap: 8px;
          transform: translateX(-50%);
          padding: 10px 16px;
          border-radius: 999px;
          background: var(--foreground);
          color: var(--background);
          font-size: 14px;
          white-space: nowrap;
          box-shadow: 0 8px 22px rgb(74 34 54 / 22%);
        }
        @media (prefers-reduced-motion: no-preference) {
          .carded-toast:not(:empty) {
            animation: carded-toast-in 180ms ease-out;
          }
        }
        @keyframes carded-toast-in {
          from {
            opacity: 0;
            transform: translate(-50%, 6px);
          }
        }
        @media (max-width: 639px) {
          .carded-thumb-bar {
            position: sticky;
            bottom: 0;
            z-index: 10;
            padding-top: 0.75rem;
            padding-bottom: max(1rem, env(safe-area-inset-bottom));
            background: var(--background);
          }
          .carded-thumb-bar button {
            min-height: 3rem;
            flex: 1 1 0;
          }
        }
        .carded-scene {
          perspective: 1400px;
        }
        /* Both faces share one grid cell, so the card is always as tall as the taller face. */
        .carded-flipper {
          position: relative;
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          min-height: 220px;
          width: 100%;
          cursor: pointer;
          transform-style: preserve-3d;
          transition: transform 700ms ease;
        }
        @media (min-width: 640px) {
          .carded-flipper {
            min-height: 260px;
          }
        }
        .carded-flipper.is-flipped {
          transform: rotateX(180deg);
        }
        .carded-face {
          grid-area: 1 / 1;
          display: flex;
          min-width: 0;
          min-height: 220px;
          width: 100%;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          border-radius: 1rem;
          border: 1px solid color-mix(in oklch, var(--border) 80%, transparent);
          background: color-mix(in oklch, var(--surface) 70%, transparent);
          padding: 3.25rem 1.5rem 2.5rem;
          text-align: center;
          box-shadow: 0 10px 30px oklch(0 0 0 / 25%);
          backface-visibility: hidden;
          -webkit-backface-visibility: hidden;
        }
        @media (min-width: 640px) {
          .carded-face {
            min-height: 260px;
          }
        }
        @media (max-width: 639px) {
          /* The card tools sit top-left on phones; 44px touch targets need the taller top. */
          .carded-face {
            padding-top: 3.5rem;
          }
        }
        .carded-back {
          background: color-mix(in oklch, var(--primary) 10%, var(--surface));
          border-color: color-mix(in oklch, var(--primary) 30%, var(--border));
          transform: rotateX(180deg);
        }
      `}</style>
    </div>
  );
}
