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
import { isClozeCardFront, renderClozeText } from "@/lib/learning";
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
  onCardsChange: (cards: DurableCardView[]) => void;
};

function parseCards(
  contentJson: unknown | null,
  content: string | null,
): CardedItem[] {
  return parseCardedItems(contentJson, content ?? "");
}

function isDurableCard(value: CardedItem | DurableCardView): value is DurableCardView {
  return "revision" in value && typeof value.revision === "number";
}

function isDueNow(dueAt: string, now: number) {
  const due = new Date(dueAt).getTime();
  return Number.isFinite(due) && due <= now;
}

function nextIntervalCopy(rating: "again" | "good", intervalDays: number) {
  if (rating === "again") return "show tonight";
  return `next in ${intervalDays} days`;
}

export function CardedView({ contentJson, content, reviewerId, durableCards, onCardsChange }: CardedViewProps) {
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
  const [index, setIndex] = useState(0);
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

  useEffect(() => {
    return () => {
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    };
  }, []);

  const safeIndex = Math.min(index, Math.max(0, cards.length - 1));
  const card = cards[safeIndex];
  const isCloze = Boolean(card && (card.kind === "cloze" || isClozeCardFront(card.front)));
  const draftIsStale =
    editing &&
    (!isDurableCard(card) || draftCardId !== card.id || draftRevision !== card.revision);

  if (!card) {
    return (
      <EmptyState
        icon={<Cards weight="duotone" className="size-5" />}
        title="Carded is empty"
        description="Generate the pack to build flashcards from the Summary. Flip a card, then step previous or next."
      />
    );
  }

  function go(delta: number) {
    setFlipped(false);
    setClozeRevealed(false);
    setScheduleHint(null);
    setIndex((prev) => {
      const next = prev + delta;
      if (next < 0) return 0;
      if (next >= cards.length) return cards.length - 1;
      return next;
    });
  }

  function toggleFlip() {
    if (busy || scheduleHint) return;
    setFlipped((open) => !open);
  }

  async function review(rating: "again" | "good") {
    if (!isDurableCard(card)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/cards/${card.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: card.revision, rating }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { card: DurableCardView };
      onCardsChange(durableCards.map((item) => item.id === data.card.id ? data.card : item));
      setScheduleHint(nextIntervalCopy(rating, data.card.intervalDays));
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
      advanceTimer.current = window.setTimeout(() => {
        setScheduleHint(null);
        setFlipped(false);
        setClozeRevealed(false);
        setIndex((prev) => {
          if (cards.length <= 1) return 0;
          const next = prev + 1;
          return next >= cards.length ? 0 : next;
        });
        advanceTimer.current = null;
      }, 700);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save review.");
    } finally {
      setBusy(false);
    }
  }

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

  const frontSource =
    isCloze && !clozeRevealed ? renderClozeText(card.front) : card.front;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <div className="flex items-start justify-between gap-2 text-sm text-muted-foreground">
        <div className="space-y-1">
          <p className="text-foreground">Memorize. No choices.</p>
          <p>Remaining {remainingDue} due</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setIndex(0);
            setFlipped(false);
            setClozeRevealed(false);
            setScheduleHint(null);
          }}
        >
          <ArrowCounterClockwise weight="bold" />
          Restart
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {isDurableCard(card) ? <span>Due {new Date(card.dueAt).toLocaleDateString()}</span> : null}
        {isDurableCard(card) && (card.isEdited || card.isPinned) ? <span className="text-amber-200">Protected from silent overwrite</span> : null}
        {isDurableCard(card) ? <button type="button" className="rounded border border-border px-2 py-1 text-foreground hover:bg-muted" onClick={() => { if (!editing) { setFrontDraft(card.front); setBackDraft(card.back); setDraftCardId(card.id); setDraftRevision(card.revision); } setEditing((open) => !open); }} disabled={busy}>{editing ? "Cancel edit" : "Edit card"}</button> : null}
        {isDurableCard(card) ? <button type="button" className="rounded border border-border px-2 py-1 text-foreground hover:bg-muted" onClick={() => void togglePin()} disabled={busy}>{card.isPinned ? "Unpin" : "Pin card"}</button> : null}
      </div>

      {isCloze ? (
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

      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => go(-1)}
          disabled={safeIndex === 0}
        >
          <CaretLeft weight="bold" />
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => go(1)}
          disabled={safeIndex >= cards.length - 1}
        >
          Next
          <CaretRight weight="bold" />
        </Button>
      </div>

      {editing ? (
        <div className="space-y-2 rounded-xl border border-border/80 bg-surface/50 p-4">
          <label className="grid gap-1 text-xs text-muted-foreground">Front<textarea value={frontDraft} onChange={(event) => setFrontDraft(event.target.value)} className="min-h-20 rounded-md border border-border bg-background p-2 text-sm text-foreground" /></label>
          <p className="text-xs text-muted-foreground">Use balanced {"{{answer}}"} placeholders for a cloze card.</p>
          <label className="grid gap-1 text-xs text-muted-foreground">Back<textarea value={backDraft} onChange={(event) => setBackDraft(event.target.value)} className="min-h-20 rounded-md border border-border bg-background p-2 text-sm text-foreground" /></label>
          <Button type="button" onClick={() => void saveEdit()} disabled={busy || !frontDraft.trim() || !backDraft.trim()}>{busy ? "Saving" : "Save card"}</Button>
        </div>
      ) : null}
      {isDurableCard(card) && flipped ? (
        <div className="flex flex-wrap gap-2 rounded-xl border border-border/80 bg-surface/50 p-4">
          {scheduleHint ? (
            <p className="w-full text-sm text-foreground">{scheduleHint}</p>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => void review("again")} disabled={busy}>Again</Button>
              <Button type="button" variant="secondary" onClick={() => void review("good")} disabled={busy}>Good</Button>
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
