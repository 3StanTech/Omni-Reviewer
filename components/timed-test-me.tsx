"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowRight,
  CheckCircle,
  Clock,
  Play,
  XCircle,
} from "@phosphor-icons/react";

import { MarkdownBody } from "@/components/study-markdown";
import { Button } from "@/components/ui/button";
import { DEFAULT_TIMED_TEST_SECONDS } from "@/lib/test-timing-constants";
import type { TestMeItem } from "@/lib/types";
import { readApiError, cn } from "@/lib/utils";

type AttemptStats = {
  itemId: string;
  attempts: number;
  misses: number;
  lastAttemptedAt: string | null;
};

type TimedSessionResponse = {
  sessionToken: string;
  sessionId: string;
  startedAt: string;
  expiresAt: string;
  durationSeconds: number;
  answeredCount?: number;
  answeredItemIds?: string[];
};

type TimedSessionLookupResponse = TimedSessionResponse | { session: null };

type TimedTestMeProps = {
  items: TestMeItem[];
  reviewerId: string;
  viewRevision: number;
  onAttemptStatsChange: (stats: AttemptStats[]) => void;
  onExit: () => void;
};

type TimedSession = TimedSessionResponse & {
  expiresAtMs: number;
  answeredItemIds: string[];
};

function formatRemaining(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function isCorrect(selected: string, answer: string): boolean {
  return selected.trim().toLowerCase() === answer.trim().toLowerCase();
}

export function TimedTestMe({
  items,
  reviewerId,
  viewRevision,
  onAttemptStatsChange,
  onExit,
}: TimedTestMeProps) {
  const [session, setSession] = useState<TimedSession | null>(null);
  const [started, setStarted] = useState(false);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [loadingSession, setLoadingSession] = useState(true);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const applySession = useCallback((data: TimedSessionResponse): boolean => {
    const expiresAtMs = Date.parse(data.expiresAt);
    const startedAtMs = Date.parse(data.startedAt);
    const answeredItemIds = Array.isArray(data.answeredItemIds)
      ? data.answeredItemIds.filter((itemId) => typeof itemId === "string")
      : [];
    if (
      !data.sessionToken ||
      !data.sessionId ||
      !Number.isFinite(expiresAtMs) ||
      !Number.isFinite(startedAtMs) ||
      expiresAtMs <= startedAtMs
    ) {
      return false;
    }
    const currentItems = itemsRef.current;
    const nextIndex = currentItems.findIndex((candidate) => !answeredItemIds.includes(candidate.id));
    setSession({ ...data, expiresAtMs, answeredItemIds });
    setStarted(true);
    setComplete(nextIndex === -1);
    setIndex(nextIndex === -1 ? Math.max(0, currentItems.length - 1) : nextIndex);
    setSelected("");
    setSubmitted(false);
    setResults({});
    setSecondsRemaining(Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000)));
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function resumeActiveSession() {
      try {
        const response = await fetch(
          `/api/reviewers/${reviewerId}/test-attempts/session?expectedRevision=${viewRevision}`,
          { method: "GET" },
        );
        if (cancelled) return;
        if (!response.ok) {
          setMessage(await readApiError(response));
          return;
        }
        const data = (await response.json()) as TimedSessionLookupResponse;
        if (!("sessionToken" in data)) return;
        if (!cancelled && !applySession(data)) {
          setMessage("Timed test returned an invalid session.");
        }
      } catch (caught) {
        if (!cancelled) {
          setMessage(caught instanceof Error ? caught.message : "Could not resume timed run.");
        }
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    }
    void resumeActiveSession();
    return () => { cancelled = true; };
  }, [applySession, reviewerId, viewRevision]);

  const item = items[index];
  const score = useMemo(
    () => Object.values(results).filter(Boolean).length,
    [results],
  );

  useEffect(() => {
    if (!session) return;
    const activeSession = session;
    function tick() {
      const next = Math.max(0, Math.ceil((activeSession.expiresAtMs - Date.now()) / 1000));
      setSecondsRemaining(next);
      if (next <= 0) {
        setMessage("Time is up. Start a new timed run to try again.");
      }
    }
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [session]);

  async function startRun() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/test-attempts/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: viewRevision,
          durationSeconds: DEFAULT_TIMED_TEST_SECONDS,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as TimedSessionResponse;
      if (!applySession(data)) throw new Error("Timed test returned an invalid session.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not start timed run.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswer() {
    if (!session || !item || submitted || secondsRemaining <= 0) return;
    const answer = selected.trim();
    if (!answer) {
      setMessage("Choose or enter an answer before continuing.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/test-attempts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "timed",
          sessionToken: session.sessionToken,
          expectedRevision: viewRevision,
          itemId: item.id,
          selectedAnswer: answer,
        }),
      });
      if (!response.ok) {
        const error = await readApiError(response);
        if (response.status === 409) {
          if (/already saved/i.test(error)) {
            setMessage(error);
          } else {
            setSession(null);
            setStarted(false);
            setMessage(error || "This timed run is no longer valid. Start again.");
          }
        } else {
          setMessage(error);
        }
        return;
      }
      const data = (await response.json()) as { stats: AttemptStats[] };
      onAttemptStatsChange(data.stats);
      setResults((previous) => ({ ...previous, [item.id]: isCorrect(answer, item.answer) }));
      setSession((previous) => previous
        ? {
            ...previous,
            answeredItemIds: previous.answeredItemIds.includes(item.id)
              ? previous.answeredItemIds
              : [...previous.answeredItemIds, item.id],
          }
        : previous);
      setSubmitted(true);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not save this answer.");
    } finally {
      setBusy(false);
    }
  }

  function nextQuestion() {
    if (!submitted) return;
    const answered = session?.answeredItemIds ?? [];
    const nextIndex = items.findIndex(
      (candidate, candidateIndex) => candidateIndex > index && !answered.includes(candidate.id),
    );
    if (nextIndex === -1) {
      setComplete(true);
      return;
    }
    setIndex(nextIndex);
    setSelected("");
    setSubmitted(false);
    setMessage(null);
  }

  function reset() {
    setSession(null);
    setStarted(false);
    setComplete(false);
    setIndex(0);
    setSelected("");
    setSubmitted(false);
    setResults({});
    setMessage(null);
    setLoadingSession(false);
  }

  if (!started || !session) {
    return (
      <section className="space-y-4 rounded-xl border border-border/80 bg-surface/50 p-4 sm:p-6" aria-labelledby="timed-test-title">
        <div className="flex items-start gap-3">
          <Clock weight="duotone" className="mt-0.5 size-6 shrink-0 text-primary" />
          <div>
            <h2 id="timed-test-title" className="text-base font-semibold text-foreground">Timed Test Me</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              One question at a time for {Math.floor(DEFAULT_TIMED_TEST_SECONDS / 60)} minutes. Answers are checked and saved by the server before you continue.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void startRun()} disabled={busy || loadingSession}>
            <Play weight="bold" />
            {loadingSession ? "Checking" : busy ? "Starting" : "Start timed run"}
          </Button>
          <Button type="button" variant="ghost" onClick={onExit} disabled={busy}>Back to study list</Button>
        </div>
        {message ? <p role="alert" className="text-sm text-destructive">{message}</p> : null}
      </section>
    );
  }

  if (complete || !item) {
    return (
      <section className="space-y-4 rounded-xl border border-border/80 bg-surface/50 p-4 sm:p-6" aria-labelledby="timed-complete-title">
        <div className="flex items-start gap-3">
          <CheckCircle weight="duotone" className="mt-0.5 size-6 shrink-0 text-success" />
          <div>
            <h2 id="timed-complete-title" className="text-base font-semibold text-foreground">Timed run complete</h2>
            <p className="mt-1 text-sm text-muted-foreground">{score} of {items.length} correct. Your attempts and misses are saved.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={reset}><ArrowCounterClockwise weight="bold" />Start again</Button>
          <Button type="button" variant="ghost" onClick={onExit}>Back to study list</Button>
        </div>
      </section>
    );
  }

  const questionId = `timed-test-question-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const choiceId = (choiceIndex: number) => `${questionId}-choice-${choiceIndex + 1}`;
  const expired = secondsRemaining <= 0;

  return (
    <section className="space-y-4" aria-labelledby={questionId}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-surface/50 px-4 py-3">
        <span className="text-sm text-muted-foreground">Question {index + 1} of {items.length}</span>
        <span className={cn("inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums", secondsRemaining <= 30 && "text-destructive")} role="timer" aria-live="polite">
          <Clock weight="bold" />
          {formatRemaining(secondsRemaining)}
        </span>
      </div>

      <article className="rounded-xl border border-border/80 bg-surface/50 p-4 sm:p-6">
        <div id={questionId} className="mb-4 text-sm font-medium leading-relaxed text-foreground">
          <MarkdownBody source={item.question} />
        </div>
        {item.choices ? (
          <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={questionId}>
            {item.choices.map((choice, choiceIndex) => {
              const active = selected === choice;
              return (
                <button
                  key={choiceId(choiceIndex)}
                  id={choiceId(choiceIndex)}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={submitted || expired || busy}
                  className={cn(
                    "min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                    active ? "border-primary/50 bg-primary/10 text-foreground" : "border-border/80 bg-background/40 text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                  onClick={() => { setSelected(choice); setMessage(null); }}
                >
                  <MarkdownBody source={choice} inline />
                </button>
              );
            })}
          </div>
        ) : (
          <label className="grid gap-1 text-xs text-muted-foreground" htmlFor={`${questionId}-answer`}>
            <span>Open response</span>
            <input
              id={`${questionId}-answer`}
              value={selected}
              disabled={submitted || expired || busy}
              onChange={(event) => { setSelected(event.target.value); setMessage(null); }}
              className="min-h-11 rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            />
          </label>
        )}

        {submitted ? (
          <div className="mt-4 space-y-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-3" role="status">
            <p className={cn("inline-flex items-center gap-1 text-sm font-medium", results[item.id] ? "text-success" : "text-destructive")}>
              {results[item.id] ? <CheckCircle weight="fill" /> : <XCircle weight="fill" />}
              {results[item.id] ? "Correct" : "Incorrect"}
            </p>
            <div className="text-sm text-muted-foreground"><strong className="text-foreground">Answer:</strong> <MarkdownBody source={item.answer} inline /></div>
            {item.explanation ? <MarkdownBody source={item.explanation} /> : null}
          </div>
        ) : null}
      </article>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onExit} disabled={busy}>Exit run</Button>
        <div className="flex gap-2">
          {submitted ? (
            <Button type="button" onClick={nextQuestion}><ArrowRight weight="bold" />{index >= items.length - 1 ? "Finish" : "Next question"}</Button>
          ) : (
            <Button type="button" onClick={() => void submitAnswer()} disabled={busy || expired || !selected.trim()}>{busy ? "Saving" : "Submit answer"}</Button>
          )}
        </div>
      </div>
      {message ? <p role="alert" className="text-sm text-destructive">{message}</p> : null}
      {expired && !message ? <p role="status" className="text-sm text-destructive">Time is up. Your next answer cannot be saved.</p> : null}
    </section>
  );
}
