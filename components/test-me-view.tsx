"use client";

import { useMemo, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowRight,
  CheckCircle,
  Clock,
  ListChecks,
  XCircle,
} from "@phosphor-icons/react";

import { EmptyState } from "@/components/empty-state";
import { MarkdownBody } from "@/components/study-markdown";
import { TimedTestMe } from "@/components/timed-test-me";
import { Button } from "@/components/ui/button";
import { parseTestMeItems } from "@/lib/learning";
import type { TestMeItem } from "@/lib/types";
import { cn, readApiError } from "@/lib/utils";

type AttemptStats = {
  itemId: string;
  attempts: number;
  misses: number;
  lastAttemptedAt: string | null;
};

type TestMeViewProps = {
  contentJson: unknown | null;
  content: string | null;
  reviewerId: string;
  viewRevision: number;
  attemptStats: AttemptStats[];
  onAttemptStatsChange: (stats: AttemptStats[]) => void;
};

function controlId(itemId: string, suffix: string): string {
  const trimmed = itemId.trim();
  const readable = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "item";
  const encoded = Array.from(trimmed)
    .map((character) => (character.codePointAt(0) ?? 0).toString(16))
    .join("-");
  return `test-me-${readable}-${encoded || "item"}-${suffix}`;
}

function isCorrect(selected: string, answer: string): boolean {
  return selected.trim().toLowerCase() === answer.trim().toLowerCase();
}

export function TestMeView({
  contentJson,
  content,
  reviewerId,
  viewRevision,
  attemptStats,
  onAttemptStatsChange,
}: TestMeViewProps) {
  const items = useMemo(
    () => parseTestMeItems(contentJson, content ?? ""),
    [contentJson, content],
  );
  const [timed, setTimed] = useState(false);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<ListChecks weight="duotone" className="size-5" />}
        title="Test Me is empty"
        description="Generate new multiple-choice questions from Locked In. Legacy open-ended questions remain answerable. Save your answers to revisit misses."
      />
    );
  }

  if (timed) {
    return (
      <TimedTestMe
        key={viewRevision}
        items={items}
        reviewerId={reviewerId}
        viewRevision={viewRevision}
        onAttemptStatsChange={onAttemptStatsChange}
        onExit={() => setTimed(false)}
      />
    );
  }

  return (
    <UntimedSitting
      key={viewRevision}
      items={items}
      reviewerId={reviewerId}
      viewRevision={viewRevision}
      attemptStats={attemptStats}
      onAttemptStatsChange={onAttemptStatsChange}
      onStartTimed={() => setTimed(true)}
    />
  );
}

function UntimedSitting({
  items,
  reviewerId,
  viewRevision,
  attemptStats,
  onAttemptStatsChange,
  onStartTimed,
}: {
  items: TestMeItem[];
  reviewerId: string;
  viewRevision: number;
  attemptStats: AttemptStats[];
  onAttemptStatsChange: (stats: AttemptStats[]) => void;
  onStartTimed: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [complete, setComplete] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const item = items[Math.min(index, items.length - 1)];
  const score = Object.values(results).filter(Boolean).length;
  const missedItems = items.filter((candidate) => results[candidate.id] === false);
  const savedMisses = attemptStats.reduce((sum, stats) => sum + stats.misses, 0);

  function resetSitting() {
    setIndex(0);
    setSelected("");
    setSubmitted(false);
    setResults({});
    setComplete(false);
    setSaveMessage(null);
  }

  async function submitAnswer() {
    if (!item || submitted || saveBusy) return;
    const answer = selected.trim();
    if (!answer) {
      setSaveMessage("Choose or enter an answer before continuing.");
      return;
    }
    setSaveBusy(true);
    setSaveMessage(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/test-attempts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: viewRevision,
          answers: [{ itemId: item.id, selectedAnswer: answer }],
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { stats: AttemptStats[] };
      onAttemptStatsChange(data.stats);
      setResults((previous) => ({ ...previous, [item.id]: isCorrect(answer, item.answer) }));
      setSubmitted(true);
    } catch (caught) {
      setSaveMessage(caught instanceof Error ? caught.message : "Could not save this answer.");
    } finally {
      setSaveBusy(false);
    }
  }

  function nextQuestion() {
    if (!submitted) return;
    if (index >= items.length - 1) {
      setComplete(true);
      return;
    }
    setIndex((current) => current + 1);
    setSelected("");
    setSubmitted(false);
    setSaveMessage(null);
  }

  const timedRunButton = (
    <Button type="button" variant="outline" size="sm" onClick={onStartTimed}>
      <Clock weight="bold" />
      Timed run
    </Button>
  );

  if (complete || !item) {
    return (
      <section className="space-y-4" aria-labelledby="test-me-complete-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id="test-me-complete-title" className="text-base font-semibold text-foreground">
            Sitting complete
          </h2>
          {timedRunButton}
        </div>

        <div className="rounded-xl border border-border/80 bg-surface/50 p-4 sm:p-6">
          <p className="text-sm font-medium text-foreground">
            {score} of {items.length} correct.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Attempts and misses are saved.
            {savedMisses > 0
              ? ` ${savedMisses} saved miss${savedMisses === 1 ? "" : "es"} to revisit.`
              : ""}
          </p>

          <div className="mt-4 space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Misses</h3>
            {missedItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No misses this sitting.</p>
            ) : (
              <ol className="space-y-2">
                {missedItems.map((missed) => (
                  <li
                    key={missed.id}
                    className="rounded-lg border border-border/60 bg-muted/40 px-3 py-3 text-sm"
                  >
                    <div className="font-medium text-foreground">
                      <MarkdownBody source={missed.question} />
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      Answer: <MarkdownBody source={missed.answer} inline />
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <Button type="button" onClick={resetSitting}>
          <ArrowCounterClockwise weight="bold" />
          Start again
        </Button>
      </section>
    );
  }

  const questionId = controlId(item.id, "question");
  const correct = results[item.id];

  return (
    <section className="space-y-4" aria-labelledby="test-me-sitting-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="test-me-sitting-title" className="text-base font-semibold text-foreground">
            Exam sitting. Pick an answer.
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Question {index + 1} of {items.length}
          </p>
        </div>
        {timedRunButton}
      </div>

      <SittingItem
        item={item}
        questionId={questionId}
        selected={selected}
        submitted={submitted}
        saveBusy={saveBusy}
        correct={correct}
        onSelect={(value) => {
          setSelected(value);
          setSaveMessage(null);
        }}
      />

      <div className="flex flex-wrap items-center justify-end gap-2">
        {submitted ? (
          <Button type="button" onClick={nextQuestion}>
            <ArrowRight weight="bold" />
            {index >= items.length - 1 ? "Finish" : "Next question"}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => void submitAnswer()}
            disabled={saveBusy || !selected.trim()}
          >
            {saveBusy ? "Saving" : "Submit answer"}
          </Button>
        )}
      </div>
      {saveMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {saveMessage}
        </p>
      ) : null}
    </section>
  );
}

function SittingItem({
  item,
  questionId,
  selected,
  submitted,
  saveBusy,
  correct,
  onSelect,
}: {
  item: TestMeItem;
  questionId: string;
  selected: string;
  submitted: boolean;
  saveBusy: boolean;
  correct: boolean | undefined;
  onSelect: (value: string) => void;
}) {
  const locked = submitted || saveBusy;

  return (
    <article className="rounded-xl border border-border/80 bg-surface/50 p-4 sm:p-6">
      <div id={questionId} className="mb-4 text-sm font-medium leading-relaxed text-foreground">
        <MarkdownBody source={item.question} />
      </div>

      {item.choices ? (
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby={questionId}>
          {item.choices.map((choice, choiceIndex) => {
            const choiceId = controlId(item.id, `choice-${choiceIndex + 1}`);
            const active = selected === choice;
            return (
              <button
                key={choiceId}
                id={choiceId}
                name={controlId(item.id, "choices")}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={locked}
                className={cn(
                  "flex min-h-11 min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                  active
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border/80 bg-background/40 text-muted-foreground hover:border-border hover:text-foreground",
                )}
                onClick={() => onSelect(choice)}
              >
                <span
                  aria-hidden
                  className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold tabular-nums text-foreground"
                >
                  {choiceIndex + 1}
                </span>
                <span className="min-w-0 flex-1 break-words">
                  <MarkdownBody source={choice} inline />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <label
          htmlFor={controlId(item.id, "answer")}
          className="grid gap-1 text-xs text-muted-foreground"
        >
          <span id={controlId(item.id, "answer-label")}>Open response</span>
          <input
            id={controlId(item.id, "answer")}
            name={controlId(item.id, "answer")}
            value={selected}
            disabled={locked}
            onChange={(event) => onSelect(event.target.value)}
            className="min-h-11 rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            aria-labelledby={`${questionId} ${controlId(item.id, "answer-label")}`}
          />
        </label>
      )}

      {submitted ? (
        <div className="mt-4 space-y-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-3" role="status">
          <p
            className={cn(
              "inline-flex items-center gap-1 text-sm font-medium",
              correct ? "text-success" : "text-destructive",
            )}
          >
            {correct ? <CheckCircle weight="fill" /> : <XCircle weight="fill" />}
            {correct ? "Correct" : "Incorrect"}
          </p>
          <div className="text-sm text-muted-foreground">
            <strong className="text-foreground">Answer:</strong>{" "}
            <MarkdownBody source={item.answer} inline />
          </div>
          {item.explanation ? <MarkdownBody source={item.explanation} /> : null}
        </div>
      ) : null}
    </article>
  );
}
