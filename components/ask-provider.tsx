"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Lightbulb } from "@phosphor-icons/react";

import { AskPanel } from "@/components/ask-panel";
import type { MakeCardResult } from "@/components/ask-message";
import { AskWhyProvider } from "@/components/unsourced-tag";
import { Button } from "@/components/ui/button";
import type { AskRequest, AskResponse, ChatMessageDto } from "@/lib/ask-types";
import type { SectionMastery } from "@/lib/mastery";
import { cn, readApiError } from "@/lib/utils";

export type SavedAnswer = { answer: ChatMessageDto; question: ChatMessageDto | null };

export type SavedStatus = "idle" | "loading" | "ready" | "error";

type AskApi = {
  reviewerId: string;
  isOpen: boolean;
  pending: boolean;
  open: () => void;
  close: () => void;
  /** Opens the panel and runs the request. Resolves true when it succeeded. */
  ask: (request: AskRequest) => Promise<boolean>;
  saved: SavedAnswer[];
  savedStatus: SavedStatus;
  /** Saved answers: the server's count until the thread loads, then the live list length. */
  savedCount: number;
  /** Loads the thread and saved answers once. Nothing loads until this or open() runs. */
  ensureLoaded: () => void;
  /** Take an answer out of Notes. Rejects when the server refuses. */
  removeSaved: (messageId: string) => Promise<void>;
};

const AskContext = createContext<AskApi | null>(null);

export function useAsk(): AskApi {
  const value = useContext(AskContext);
  if (!value) throw new Error("useAsk needs an AskProvider");
  return value;
}

/** Null outside a pack, so shared components can hide their Ask actions there. */
export function useOptionalAsk(): AskApi | null {
  return useContext(AskContext);
}

/** Bounds a typed (open-response) answer sent with Explain. */
export const EXPLAIN_CHOSEN_MAX_CHARS = 500;

const MAX_CHIP_TITLE_CHARS = 80;
const BASE_STARTER_CHIPS = ["What will likely be asked?", "Make me a mnemonic for this lecture"];

/** The weakest section that has a score under the weak threshold, or null. */
function weakestSectionTitle(sections: SectionMastery[] | null): string | null {
  let weakest: SectionMastery | null = null;
  for (const section of sections ?? []) {
    if (!section.weak || section.score === null || !section.title.trim()) continue;
    if (!weakest || (section.score ?? 1) < (weakest.score ?? 1)) weakest = section;
  }
  if (!weakest) return null;
  const title = weakest.title.trim();
  return title.length > MAX_CHIP_TITLE_CHARS ? title.slice(0, MAX_CHIP_TITLE_CHARS).trimEnd() : title;
}

const NETWORK_ERROR = "Could not reach the server. Check your connection and try again.";

async function requestJson(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(NETWORK_ERROR);
  }
}

/** The A key opens Ask unless the user is typing or a dialog is open. */
function shouldOpenOnKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.key.toLowerCase() !== "a") return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true'], [data-ask-panel]")) {
    return false;
  }
  if (document.querySelector("[role='dialog']:not([hidden]), [role='alertdialog']:not([hidden]), dialog[open]")) return false;
  return true;
}

type AskProviderProps = {
  reviewerId: string;
  /** The pack's section mastery, for the "Explain <weakest section>" starter chip. */
  sections?: SectionMastery[] | null;
  /** The server's count of saved answers, used until the thread loads. */
  initialSavedCount?: number;
  /** Called after "Make a card" creates a card, so Carded can refresh. */
  onCardCreated?: () => void;
  children: ReactNode;
};

/** One provider and one panel per pack, so the thread and draft survive mode changes. */
export function AskProvider(props: AskProviderProps) {
  return <AskProviderInner key={props.reviewerId} {...props} />;
}

function AskProviderInner({ reviewerId, sections = null, initialSavedCount = 0, onCardCreated, children }: AskProviderProps) {
  const askUrl = `/api/reviewers/${encodeURIComponent(reviewerId)}/ask`;
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [saved, setSaved] = useState<SavedAnswer[]>([]);
  const [savedStatus, setSavedStatus] = useState<SavedStatus>("idle");
  const [pending, setPending] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const loadRef = useRef<Promise<boolean> | null>(null);
  const pendingRef = useRef(false);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const load = useCallback((): Promise<boolean> => {
    if (loadRef.current) return loadRef.current;
    const run = (async () => {
      setSavedStatus("loading");
      setError(null);
      try {
        const res = await requestJson(askUrl);
        if (!res.ok) throw new Error(await readApiError(res));
        const data = (await res.json()) as { messages: ChatMessageDto[]; saved: SavedAnswer[] };
        setMessages(data.messages);
        setSaved(data.saved);
        setSavedStatus("ready");
        return true;
      } catch (caught) {
        // A failed load can be retried the next time the panel opens.
        loadRef.current = null;
        setSavedStatus("error");
        setError(caught instanceof Error ? caught.message : "Could not load your chat.");
        return false;
      }
    })();
    loadRef.current = run;
    return run;
  }, [askUrl]);

  const ensureLoaded = useCallback(() => {
    void load();
  }, [load]);

  const open = useCallback(() => {
    setIsOpen(true);
    ensureLoaded();
  }, [ensureLoaded]);

  const close = useCallback(() => setIsOpen(false), []);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (next) open();
      else close();
    },
    [close, open],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!shouldOpenOnKey(event)) return;
      event.preventDefault();
      open();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const ask = useCallback(
    async (request: AskRequest): Promise<boolean> => {
      setIsOpen(true);
      if (pendingRef.current) return false;
      pendingRef.current = true;
      setPending(true);
      // The server builds Explain and Ask why display text, so show a short label until its pair arrives.
      setPendingQuestion(
        request.kind === "ask" ? request.question : request.kind === "explain" ? "Explain this" : "Ask why",
      );
      setError(null);
      setScrollToMessageId(null);
      try {
        if (!(await load())) throw new Error("Could not load your chat. Close Ask and open it again.");
        const res = await requestJson(askUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!res.ok) throw new Error(await readApiError(res));
        const data = (await res.json()) as AskResponse;
        setMessages((current) => {
          const known = new Set(current.map((message) => message.id));
          const fresh = data.messages.filter((message) => !known.has(message.id));
          return fresh.length > 0 ? [...current, ...fresh] : current;
        });
        if (data.reused) {
          const target = data.messages.find((message) => message.role === "assistant") ?? data.messages[0];
          setScrollToMessageId(target?.id ?? null);
        }
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The question was not sent. Try again.");
        return false;
      } finally {
        pendingRef.current = false;
        setPending(false);
        setPendingQuestion(null);
      }
    },
    [askUrl, load],
  );

  // The composer clears on send and gets its text back if the send fails.
  const sendQuestion = useCallback(
    async (question: string) => {
      setDraft("");
      const ok = await ask({ kind: "ask", question });
      if (!ok) setDraft((current) => current || question);
    },
    [ask],
  );

  const applyMessage = useCallback((message: ChatMessageDto) => {
    setMessages((current) => current.map((item) => (item.id === message.id ? message : item)));
    setSaved((current) => {
      const without = current.filter((entry) => entry.answer.id !== message.id);
      if (!message.saved) return without;
      const question =
        messagesRef.current.find((item) => item.id === message.replyToId && item.role === "user")
        ?? current.find((entry) => entry.answer.id === message.id)?.question
        ?? null;
      return [{ answer: message, question }, ...without];
    });
  }, []);

  const toggleSaved = useCallback(
    async (messageId: string, next: boolean) => {
      const res = await requestJson(`${askUrl}/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saved: next }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const data = (await res.json()) as { message: ChatMessageDto };
      applyMessage(data.message);
    },
    [applyMessage, askUrl],
  );

  const removeSaved = useCallback((messageId: string) => toggleSaved(messageId, false), [toggleSaved]);

  const makeCard = useCallback(
    async (messageId: string, front: string, back: string): Promise<MakeCardResult> => {
      try {
        const res = await requestJson(`${askUrl}/${encodeURIComponent(messageId)}/card`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ front, back }),
        });
        if (!res.ok) return { error: await readApiError(res) };
        const data = (await res.json()) as { created: boolean; cardId: string };
        onCardCreated?.();
        return { created: data.created };
      } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The card was not saved. Try again." };
      }
    },
    [askUrl, onCardCreated],
  );

  const clearChat = useCallback(async () => {
    setError(null);
    try {
      const res = await requestJson(askUrl, { method: "DELETE" });
      if (!res.ok) throw new Error(await readApiError(res));
      setMessages([]);
      setScrollToMessageId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not clear the chat. Try again.");
    }
  }, [askUrl]);

  const askWhy = useCallback(
    (sentence: string) => {
      void ask({ kind: "ask_why", sentence });
    },
    [ask],
  );

  const starterChips = useMemo(() => {
    const weak = weakestSectionTitle(sections);
    return weak ? [...BASE_STARTER_CHIPS, `Explain ${weak}`] : BASE_STARTER_CHIPS;
  }, [sections]);

  const savedCount = savedStatus === "ready" ? saved.length : initialSavedCount;

  const api = useMemo<AskApi>(
    () => ({ reviewerId, isOpen, pending, open, close, ask, saved, savedStatus, savedCount, ensureLoaded, removeSaved }),
    [ask, close, ensureLoaded, isOpen, open, pending, removeSaved, reviewerId, saved, savedCount, savedStatus],
  );

  return (
    <AskContext.Provider value={api}>
      <AskWhyProvider value={askWhy}>
        {/* Desktop: keep the study column clear of the side panel while it is open. */}
        <div
          data-ask-open={isOpen ? "true" : "false"}
          className={cn(
            "min-[641px]:data-[ask-open=true]:pr-[min(420px,40vw)]",
            // Leave room to scroll past the phone pill.
            "max-[640px]:pb-16",
          )}
        >
          {children}
        </div>
        <AskPanel
          open={isOpen}
          onOpenChange={onOpenChange}
          messages={messages}
          pending={pending}
          loading={savedStatus === "idle" || savedStatus === "loading"}
          pendingQuestion={pendingQuestion}
          error={error}
          draft={draft}
          onDraftChange={setDraft}
          onSend={(question) => void sendQuestion(question)}
          onClear={() => void clearChat()}
          starterChips={starterChips}
          onMakeCard={makeCard}
          onToggleSaved={toggleSaved}
          reviewerId={reviewerId}
          scrollToMessageId={scrollToMessageId}
          pillRef={pillRef}
        />
      </AskWhyProvider>
    </AskContext.Provider>
  );
}

/**
 * "Explain this" beside a missed Test Me item or a flipped card. Renders
 * nothing outside a pack, where there is no Ask panel to answer.
 */
export function ExplainThisButton({ request, className }: { request: AskRequest; className?: string }) {
  const ask = useOptionalAsk();
  if (!ask) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      disabled={ask.pending}
      onClick={() => void ask.ask(request)}
    >
      <Lightbulb weight="bold" aria-hidden />
      Explain this
    </Button>
  );
}
