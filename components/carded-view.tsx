"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaretLeft,
  CaretRight,
  Cards,
  ArrowCounterClockwise,
  Eye,
  EyeSlash,
} from "@phosphor-icons/react";

import { EmptyState } from "@/components/empty-state";
import { MarkdownBody } from "@/components/study-markdown";
import { Button } from "@/components/ui/button";
import { parseCardedItems } from "@/lib/learning";
import { scheduleCardReview } from "@/lib/sm2";
import { isClozeCardFront, renderClozeText } from "@/lib/learning";
import {
  captureDueQueue,
  type CapturedCard,
  reconcileDueSession,
} from "@/lib/practice-session";
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
};

type CardedViewProps = {
  contentJson: unknown | null;
  content: string | null;
  reviewerId: string;
  durableCards: DurableCardView[];
  examDate?: string | null;
  onCardsChange: (cards: DurableCardView[]) => void;
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

function isDueNow(dueAt: string, now: number) {
  const due = new Date(dueAt).getTime();
  return Number.isFinite(due) && due <= now;
}

function gradePreview(
  card: DurableCardView,
  rating: "again" | "good",
  examDate: string | null,
): string {
  const next = scheduleCardReview({
    dueAt: new Date(card.dueAt),
    intervalDays: card.intervalDays,
    repetitions: card.repetitions,
    easeFactor: card.easeFactor,
  }, rating, new Date(), examDate);
  return nextIntervalCopy(rating, next.intervalDays);
}

function nextIntervalCopy(rating: "again" | "good", intervalDays: number) {
  if (rating === "again") return "show tonight";
  return `next in ${intervalDays} days`;
}

export function CardedView({
  contentJson,
  content,
  reviewerId,
  durableCards,
  examDate = null,
  onCardsChange,
}: CardedViewProps) {
  const generatedCards = useMemo(
    () => parseCards(contentJson, content),
    [contentJson, content],
  );
  const cards = durableCards.length > 0 ? durableCards : generatedCards;
  // Remaining due is dueAt <= now, so the cutoff has to be wall clock.
  /* eslint-disable react-hooks/purity -- dueAt <= now needs Date.now */
  const remainingDue = useMemo(() => {
    const now = Date.now();
    return durableCards.filter((item) => isDueNow(item.dueAt, now)).length;
  }, [durableCards]);
  /* eslint-enable react-hooks/purity */
  const [mode, setMode] = useState<"due" | "browse">("due");
  const [queue, setQueue] = useState<CapturedCard[]>(() => captureDueQueue(durableCards, Date.now()));
  const [ratedIds, setRatedIds] = useState<string[]>([]);
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
  const advanceTimer = useRef<number | null>(null);
  const reviewEpoch = useRef(0);
  const requestIds = useRef(new Map<string, string>());

  useEffect(() => {
    return () => {
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    };
  }, []);

  function captureQueue() {
    setQueue(captureDueQueue(durableCards, Date.now()));
    setRatedIds([]);
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

  const browsing = mode === "browse";
  const browseCards = durableCards.length > 0 ? durableCards : generatedCards;
  const safeBrowseIndex = Math.min(browseIndex, Math.max(0, browseCards.length - 1));
  const currentDue = dueSession.current?.card ?? null;
  const card = browsing ? browseCards[safeBrowseIndex] ?? null : currentDue;
  const dueStale = !browsing && Boolean(dueSession.current?.stale);
  const isCloze = Boolean(card && (card.kind === "cloze" || isClozeCardFront(card.front)));
  const draftIsStale =
    editing &&
    (!isDurableCard(card) || draftCardId !== card.id || draftRevision !== card.revision);

  const packEmpty = cards.length === 0;

  function enterBrowse() {
    setMode("browse");
    setBrowseIndex(0);
    setFlipped(false);
    setClozeRevealed(false);
    setScheduleHint(null);
    setError(null);
  }

  function enterDue() {
    setMode("due");
    captureQueue();
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
      if (epoch !== reviewEpoch.current) return;
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { card: DurableCardView };
      onCardsChange(durableCards.map((item) => item.id === data.card.id ? data.card : item));
      setRatedIds((current) => current.includes(card.id) ? current : [...current, card.id]);
      requestIds.current.delete(card.id);
      setScheduleHint(nextIntervalCopy(rating, data.card.intervalDays));
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
      advanceTimer.current = window.setTimeout(() => {
        if (epoch !== reviewEpoch.current) return;
        setScheduleHint(null);
        setFlipped(false);
        setClozeRevealed(false);
        advanceTimer.current = null;
      }, 700);
    } catch (caught) {
      if (epoch !== reviewEpoch.current) return;
      setError(caught instanceof Error ? caught.message : "Could not save review.");
    } finally {
      if (epoch === reviewEpoch.current) setBusy(false);
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest("input, textarea, [contenteditable='true']"))) return;
      if (browsing || editing || busy || dueStale || !isDurableCard(card)) return;
      if (event.key === " " && !flipped) {
        event.preventDefault();
        setFlipped(true);
      }
      if (!flipped) return;
      if (event.key === "1") void review("again");
      if (event.key === "2") void review("good");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // review is recreated each render; the listener only needs the latest closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsing, busy, card, dueStale, editing, flipped]);

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

  const frontSource = card && isCloze && !clozeRevealed ? renderClozeText(card.front) : card?.front ?? "";

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
    : dueSession.empty
      ? "0 of 0 due"
      : `${dueSession.completed} of ${dueSession.total}`;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <div className="flex items-start justify-between gap-2 text-sm text-muted-foreground">
        <div className="space-y-1">
          <p className="text-foreground">Memorize. No choices.</p>
          <p>{sessionLabel}</p>
          <p>Remaining {remainingDue} due</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {browsing ? (
            <Button type="button" variant="ghost" size="sm" onClick={enterDue}>
              Study due
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={enterBrowse}>
              <Eye weight="bold" />
              Browse all
            </Button>
          )}
          {!browsing ? (
            <Button type="button" variant="ghost" size="sm" onClick={enterDue}>
              <ArrowCounterClockwise weight="bold" />
              Restart
            </Button>
          ) : null}
        </div>
      </div>
      {!browsing && dueSession.empty ? (
        <EmptyState
          icon={<Cards weight="duotone" className="size-5" />}
          title="No cards due"
          description="Nothing is due in this session. Browse all to inspect cards without scheduling, or start again later."
        />
      ) : null}
      {!browsing && dueSession.finished ? (
        <EmptyState
          icon={<Cards weight="duotone" className="size-5" />}
          title="Session complete"
          description={`${dueSession.completed} of ${dueSession.total} cards rated. Newly due cards wait for the next session.`}
        />
      ) : null}

      {card ? (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {isDurableCard(card) ? <span>Due {new Date(card.dueAt).toLocaleDateString()}</span> : null}
        {isDurableCard(card) && (card.isEdited || card.isPinned) ? <span className="text-warning">Protected from silent overwrite</span> : null}
        {dueStale ? <span className="text-warning">This card changed. Start a new due session before rating it.</span> : null}
        {isDurableCard(card) ? <button type="button" className="rounded border border-border px-2 py-1 text-foreground hover:bg-muted" onClick={() => { if (!editing) { setFrontDraft(card.front); setBackDraft(card.back); setDraftCardId(card.id); setDraftRevision(card.revision); } setEditing((open) => !open); }} disabled={busy}>{editing ? "Cancel edit" : "Edit card"}</button> : null}
        {isDurableCard(card) ? <button type="button" className="rounded border border-border px-2 py-1 text-foreground hover:bg-muted" onClick={() => void togglePin()} disabled={busy}>{card.isPinned ? "Unpin" : "Pin card"}</button> : null}
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
      <div className="carded-scene">
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
          aria-pressed={flipped}
        >
          <div className="carded-face carded-front">
            <span className="mb-3 text-[0.65rem] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Front
            </span>
            <MarkdownBody source={frontSource} />
            <span className="mt-6 text-xs text-muted-foreground">Flip</span>
          </div>
          <div className="carded-face carded-back">
            <span className="mb-3 text-[0.65rem] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Back
            </span>
            <MarkdownBody source={card.back} />
            <span className="mt-6 text-xs text-muted-foreground">Flip</span>
          </div>
        </div>
      </div>
      ) : null}

      {browsing ? (
      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => go(-1)}
          disabled={safeBrowseIndex === 0}
        >
          <CaretLeft weight="bold" />
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => go(1)}
          disabled={safeBrowseIndex >= browseCards.length - 1}
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
      {!browsing && isDurableCard(card) && flipped && !dueStale ? (
        <div className="flex flex-wrap gap-2 rounded-xl border border-border/80 bg-surface/50 p-4">
          {scheduleHint ? (
            <p className="w-full text-sm text-foreground">{scheduleHint}</p>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => void review("again")} disabled={busy}>
                Again, {gradePreview(card, "again", examDate)}
              </Button>
              <Button type="button" variant="secondary" onClick={() => void review("good")} disabled={busy}>
                Good, {gradePreview(card, "good", examDate)}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <style>{`
        .carded-scene {
          perspective: 1400px;
        }
        .carded-flipper {
          position: relative;
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
          display: flex;
          min-height: 220px;
          width: 100%;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          border-radius: 1rem;
          border: 1px solid color-mix(in oklch, var(--border) 80%, transparent);
          background: color-mix(in oklch, var(--surface) 70%, transparent);
          padding: 2.5rem 1.5rem;
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
        .carded-front {
          position: relative;
        }
        .carded-back {
          position: absolute;
          inset: 0;
          background: color-mix(in oklch, var(--primary) 10%, var(--surface));
          border-color: color-mix(in oklch, var(--primary) 30%, var(--border));
          transform: rotateX(180deg);
        }
      `}</style>
    </div>
  );
}
