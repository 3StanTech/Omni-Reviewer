"use client";

import { useId, useState } from "react";
import { Cards, Check, CircleNotch, Note, Question } from "@phosphor-icons/react";

import { SourceViewerProvider } from "@/components/source-modal";
import { MarkdownBody } from "@/components/study-markdown";
import { UnsourcedActionsProvider } from "@/components/unsourced-tag";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ChatMessageDto } from "@/lib/ask-types";
import { UNSOURCED_TOKEN } from "@/lib/citations";
import { isValidCardFront } from "@/lib/learning";
import { MAX_CARD_BACK_CHARS, MAX_CARD_FRONT_CHARS } from "@/lib/learning-limits";
import { cn } from "@/lib/utils";

export const ASK_REFUSED_LABEL = "Not in your slides";
export const ASK_REFUSED_COPY =
  "Your lecture does not cover this. I will not answer from outside knowledge here. Check your reference or ask your professor.";

export type MakeCardResult = { created: boolean } | { error: string };

type AskMessageProps = {
  message: ChatMessageDto;
  /** The paired user text (for Explain, the short display text). Prefills the card front. */
  question?: string;
  reviewerId: string;
  onMakeCard: (messageId: string, front: string, back: string) => Promise<MakeCardResult>;
  onToggleSaved: (messageId: string, saved: boolean) => Promise<void>;
};

/** The answer as card back text: unsourced markers dropped, citations kept, then trimmed. */
export function cardBackFromAnswer(content: string): string {
  return content
    .split(UNSOURCED_TOKEN)
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, MAX_CARD_BACK_CHARS);
}

const BUBBLE_TEXT = "text-sm leading-relaxed break-words";
const FIELD_LABEL = "text-xs font-medium text-muted-foreground";

export function AskMessage({ message, question, reviewerId, onMakeCard, onToggleSaved }: AskMessageProps) {
  if (message.role === "user") {
    return (
      <div data-message-id={message.id} className="flex justify-end">
        <p className={cn(BUBBLE_TEXT, "max-w-[85%] rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2 whitespace-pre-wrap text-foreground")}>
          {message.content}
        </p>
      </div>
    );
  }
  return (
    <AssistantBubble
      message={message}
      question={question}
      reviewerId={reviewerId}
      onMakeCard={onMakeCard}
      onToggleSaved={onToggleSaved}
    />
  );
}

type CardState =
  | { phase: "idle" }
  | { phase: "form"; front: string; back: string; saving: boolean; error: string | null }
  | { phase: "done"; created: boolean };

function AssistantBubble({ message, question, reviewerId, onMakeCard, onToggleSaved }: AskMessageProps) {
  const formId = useId();
  const [card, setCard] = useState<CardState>({ phase: "idle" });
  const [savedPending, setSavedPending] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);

  function openForm() {
    setCard({
      phase: "form",
      front: (question ?? "").trim().slice(0, MAX_CARD_FRONT_CHARS),
      back: cardBackFromAnswer(message.content),
      saving: false,
      error: null,
    });
  }

  async function saveCard() {
    if (card.phase !== "form" || card.saving) return;
    const front = card.front.trim();
    const back = card.back.trim();
    if (!front || !back) {
      setCard({ ...card, error: "Both sides need some text." });
      return;
    }
    if (!isValidCardFront(front)) {
      setCard({ ...card, error: "Close every {{ with a }} on the front, or remove them." });
      return;
    }
    setCard({ ...card, saving: true, error: null });
    try {
      const result = await onMakeCard(message.id, front, back);
      if ("error" in result) {
        setCard({ phase: "form", front: card.front, back: card.back, saving: false, error: result.error });
        return;
      }
      setCard({ phase: "done", created: result.created });
    } catch {
      setCard({ phase: "form", front: card.front, back: card.back, saving: false, error: "The card was not saved. Try again." });
    }
  }

  async function toggleSaved() {
    if (savedPending) return;
    setSavedPending(true);
    setSavedError(null);
    try {
      await onToggleSaved(message.id, !message.saved);
    } catch {
      setSavedError("Notes did not update. Try again.");
    } finally {
      setSavedPending(false);
    }
  }

  return (
    <div data-message-id={message.id} className="flex justify-start">
      <div className={cn(BUBBLE_TEXT, "max-w-full min-w-0 rounded-2xl rounded-bl-md border border-border bg-card px-3.5 py-2.5 text-card-foreground")}>
        {message.refused ? (
          <span className="mb-1.5 inline-flex items-center gap-1 rounded-[5px] bg-warning/18 px-1.5 py-0.5 text-[0.7rem] font-semibold text-warning">
            <Question weight="bold" className="size-3" aria-hidden />
            {ASK_REFUSED_LABEL}
          </span>
        ) : null}
        {/* Chat answers are not editable documents, so the unsourced tag stays informational. */}
        <UnsourcedActionsProvider value={null}>
          <SourceViewerProvider reviewerId={reviewerId} citationSources={message.citationSources}>
            {message.refused ? <p>{ASK_REFUSED_COPY}</p> : null}
            {message.content.trim() ? <MarkdownBody source={message.content} /> : null}
          </SourceViewerProvider>
        </UnsourcedActionsProvider>

        {message.refused ? null : (
          <div className="mt-2 border-t border-border/60 pt-2">
            {card.phase === "form" ? (
              <form
                className="grid gap-2"
                aria-label="Make a card"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveCard();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !card.saving) {
                    event.preventDefault();
                    event.stopPropagation();
                    setCard({ phase: "idle" });
                  }
                }}
              >
                <label htmlFor={`${formId}-front`} className={FIELD_LABEL}>Front</label>
                <Textarea
                  id={`${formId}-front`}
                  value={card.front}
                  maxLength={MAX_CARD_FRONT_CHARS}
                  disabled={card.saving}
                  className="min-h-14 text-base"
                  onChange={(event) => setCard({ ...card, front: event.target.value, error: null })}
                />
                <label htmlFor={`${formId}-back`} className={FIELD_LABEL}>Back</label>
                <Textarea
                  id={`${formId}-back`}
                  value={card.back}
                  maxLength={MAX_CARD_BACK_CHARS}
                  disabled={card.saving}
                  className="min-h-24 text-base"
                  onChange={(event) => setCard({ ...card, back: event.target.value, error: null })}
                />
                {card.error ? (
                  <p role="alert" className="text-xs text-destructive">{card.error}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" disabled={card.saving || !card.front.trim() || !card.back.trim()}>
                    {card.saving ? <CircleNotch weight="bold" className="animate-spin" aria-hidden /> : null}
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={card.saving} onClick={() => setCard({ phase: "idle" })}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {card.phase === "done" ? (
                  <span role="status" className="inline-flex min-h-11 items-center gap-1.5 px-2 text-[0.8125rem] font-medium text-success sm:min-h-9">
                    <Check weight="bold" className="size-3.5" aria-hidden />
                    {card.created ? "Card added" : "Already a card"}
                  </span>
                ) : (
                  <Button type="button" size="sm" variant="ghost" onClick={openForm}>
                    <Cards aria-hidden />
                    Make a card
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                 
                  aria-pressed={message.saved}
                  disabled={savedPending}
                  onClick={() => void toggleSaved()}
                >
                  <Note weight={message.saved ? "fill" : "regular"} aria-hidden />
                  {message.saved ? "Saved to Notes" : "Save to Notes"}
                </Button>
              </div>
            )}
            {savedError ? <p role="alert" className="mt-1 text-xs text-destructive">{savedError}</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}
