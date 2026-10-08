"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { CaretDown, CaretRight, ChatCircleDots, CircleNotch, PaperPlaneRight } from "@phosphor-icons/react";

import { AskMessage, type MakeCardResult } from "@/components/ask-message";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_ASK_QUESTION_CHARS, type ChatMessageDto } from "@/lib/ask-types";
import { cn } from "@/lib/utils";

/** The counter appears once the draft is within this many characters of the limit. */
const COUNTER_THRESHOLD = Math.floor(MAX_ASK_QUESTION_CHARS * 0.8);

type AskPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: ChatMessageDto[];
  pending: boolean;
  /** True until the first load of the thread settles (success or failure). */
  loading?: boolean;
  /** The question being answered, shown as a user bubble above the pending bubble. */
  pendingQuestion?: string | null;
  error: string | null;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: (question: string) => void;
  onClear: () => void;
  starterChips: string[];
  onMakeCard: (messageId: string, front: string, back: string) => Promise<MakeCardResult>;
  onToggleSaved: (messageId: string, saved: boolean) => Promise<void>;
  reviewerId: string;
  /** When set (Explain reuse), the thread scrolls to this message instead of the end. */
  scrollToMessageId?: string | null;
  /** The provider's handle on the pill, so the A key and focus return can reach it. */
  pillRef?: RefObject<HTMLButtonElement | null>;
};

export function AskPanel({
  open,
  onOpenChange,
  messages,
  pending,
  loading = false,
  pendingQuestion = null,
  error,
  draft,
  onDraftChange,
  onSend,
  onClear,
  starterChips,
  onMakeCard,
  onToggleSaved,
  reviewerId,
  scrollToMessageId = null,
  pillRef,
}: AskPanelProps) {
  const localPillRef = useRef<HTMLButtonElement | null>(null);
  const pill = pillRef ?? localPillRef;
  const panelRef = useRef<HTMLElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const wasOpen = useRef(false);
  const wasPending = useRef(false);
  const titleId = useId();
  const hintId = useId();
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Focus moves into the composer on open and back to the pill on close.
  useEffect(() => {
    if (open) {
      composerRef.current?.focus();
    } else if (wasOpen.current) {
      pill.current?.focus();
    }
    wasOpen.current = open;
  }, [open, pill]);

  // The composer is disabled while pending, which drops focus; take it back when the answer lands.
  useEffect(() => {
    if (open && wasPending.current && !pending) composerRef.current?.focus();
    wasPending.current = pending;
  }, [open, pending]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const panel = panelRef.current;
      const target = event.target;
      // A nested popover (the unsourced tag) or a dialog opened from a citation chip closes first.
      if (panel?.querySelector("[role='dialog']:not([hidden])")) return;
      if (target instanceof Element && target.closest("[role='dialog']") && !panel?.contains(target)) return;
      event.preventDefault();
      onOpenChange(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  // New answers scroll into view; an Explain reuse scrolls to the existing answer.
  useEffect(() => {
    if (!open) return;
    const thread = threadRef.current;
    if (!thread) return;
    if (scrollToMessageId) {
      const target = [...thread.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (element) => element.dataset.messageId === scrollToMessageId,
      );
      if (target) {
        target.scrollIntoView({ block: "start" });
        return;
      }
    }
    thread.scrollTop = thread.scrollHeight;
  }, [open, messages.length, pending, loading, scrollToMessageId]);

  if (!open) {
    return (
      <button
        ref={pill}
        type="button"
        data-ask-pill=""
        aria-label="Ask this pack"
        aria-expanded={false}
        className={cn(
          "print-hide [html[data-study-sheet-open]_&]:hidden fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 inline-flex h-11 items-center justify-center gap-1.5 rounded-full border border-border bg-card px-4 text-[0.8125rem] font-semibold text-foreground opacity-55 shadow-[0_6px_18px_oklch(0_0_0/25%)] transition-[opacity,background-color] duration-150 outline-none hover:bg-muted hover:opacity-100 focus-visible:bg-muted focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50",
          // On a phone: an icon-only circle at the edge, above Carded's grade buttons, which are left aligned.
          "max-[640px]:right-3 max-[640px]:bottom-[max(6rem,calc(env(safe-area-inset-bottom)_+_5rem))] max-[640px]:w-11 max-[640px]:px-0",
        )}
        onClick={() => onOpenChange(true)}
      >
        <ChatCircleDots weight="bold" className="size-[1.125rem]" aria-hidden />
        <span className="max-[640px]:sr-only">Ask</span>
      </button>
    );
  }

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && !pending;
  const empty = messages.length === 0;
  const userTextFor = (index: number): string | undefined => {
    const previous = messages[index - 1];
    return previous?.role === "user" ? previous.content : undefined;
  };

  function send(question: string) {
    const text = question.trim();
    if (!text || pending) return;
    onSend(text);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) send(draft);
  }

  return (
    <section
      ref={panelRef}
      data-ask-panel=""
      aria-labelledby={titleId}
      className={cn(
        "print-hide fixed z-40 flex flex-col overflow-hidden border-border bg-card text-card-foreground shadow-[0_12px_40px_oklch(0_0_0/45%)]",
        // Desktop: a right-hand panel that starts below the sticky app header (h-14 plus its 1px border),
        // so Search packs, the mood control and Topics stay usable. Phone: a bottom sheet, like the study side panel.
        "top-[calc(3.5rem+1px)] right-0 bottom-0 w-[min(420px,40vw)] border-l",
        "max-[640px]:inset-x-0 max-[640px]:top-auto max-[640px]:bottom-0 max-[640px]:h-[min(80dvh,640px)] max-[640px]:w-full max-[640px]:rounded-t-2xl max-[640px]:border-t max-[640px]:border-l-0 max-[640px]:pb-[env(safe-area-inset-bottom)]",
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <ChatCircleDots weight="bold" className="size-[1.125rem] text-primary" aria-hidden />
        <h2 id={titleId} className="min-w-0 flex-1 text-sm font-semibold">Ask this pack</h2>
        {!empty ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            aria-expanded={confirmingClear}
            disabled={pending}
            onClick={() => setConfirmingClear((value) => !value)}
          >
            Clear chat
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label="Close Ask"
          onClick={() => onOpenChange(false)}
        >
          <CaretRight weight="bold" className="max-[640px]:hidden" aria-hidden />
          <CaretDown weight="bold" className="hidden max-[640px]:block" aria-hidden />
        </Button>
      </header>

      {confirmingClear && !empty ? (
        <div role="group" aria-label="Confirm clear chat" className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5 text-sm">
          <span className="min-w-0 flex-1">Clear this chat? Answers you saved to Notes stay.</span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              setConfirmingClear(false);
              onClear();
            }}
          >
            Clear
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingClear(false)}>
            Keep chat
          </Button>
        </div>
      ) : null}

      <div
        ref={threadRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-4 py-3"
        aria-live="polite"
        aria-relevant="additions"
      >
        {loading ? (
          <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <CircleNotch weight="bold" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            Loading this pack&apos;s chat
          </p>
        ) : null}
        {empty && !loading && !pending ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Ask anything about this lecture. Answers come only from this pack&apos;s sources and cite the slide.
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested questions">
              {starterChips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  disabled={pending}
                  className="min-h-9 pointer-coarse:min-h-11 rounded-full border border-border bg-surface/40 px-3.5 py-1.5 text-left text-[0.8125rem] transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  onClick={() => send(chip)}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((message, index) => (
          <AskMessage
            key={message.id}
            message={message}
            question={message.role === "assistant" ? userTextFor(index) : undefined}
            reviewerId={reviewerId}
            onMakeCard={onMakeCard}
            onToggleSaved={onToggleSaved}
          />
        ))}
        {pending && pendingQuestion ? (
          <div className="flex justify-end">
            <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground">
              {pendingQuestion}
            </p>
          </div>
        ) : null}
        {pending ? (
          <div role="status" className="flex justify-start">
            <p className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-border bg-card px-3.5 py-2 text-sm text-muted-foreground">
              <CircleNotch weight="bold" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Reading your slides
            </p>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border px-4 py-3">
        {error ? (
          <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            ref={composerRef}
            value={draft}
            rows={1}
            maxLength={MAX_ASK_QUESTION_CHARS}
            disabled={pending}
            aria-label="Ask about this lecture"
            aria-describedby={hintId}
            placeholder="Ask about this lecture"
            className="max-h-32 min-h-11 resize-none"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <Button
            type="button"
            size="icon-lg"
            aria-label="Send question"
            disabled={!canSend}
            onClick={() => send(draft)}
          >
            <PaperPlaneRight weight="bold" aria-hidden />
          </Button>
        </div>
        <p id={hintId} className="mt-1.5 flex justify-between gap-2 text-xs text-muted-foreground">
          <span>Enter sends. Shift+Enter adds a line.</span>
          {draft.length >= COUNTER_THRESHOLD ? (
            <span className={cn(draft.length >= MAX_ASK_QUESTION_CHARS && "text-destructive")}>
              {draft.length.toLocaleString("en-US")} of {MAX_ASK_QUESTION_CHARS.toLocaleString("en-US")}
            </span>
          ) : null}
        </p>
      </div>
    </section>
  );
}
