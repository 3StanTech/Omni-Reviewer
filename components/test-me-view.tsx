"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle,
  Clock,
  Eye,
  EyeSlash,
  ListChecks,
  XCircle,
} from "@phosphor-icons/react";

import { EmptyState } from "@/components/empty-state";
import { MarkdownBody } from "@/components/study-markdown";
import { TimedTestMe } from "@/components/timed-test-me";
import { Button } from "@/components/ui/button";
import { parseTestMeItems } from "@/lib/learning";
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

export function TestMeView({
  contentJson,
  content,
  reviewerId,
  viewRevision,
  attemptStats,
  onAttemptStatsChange,
}: TestMeViewProps) {
  const items = useMemo(
    () => {
      const parsed = parseTestMeItems(contentJson, content ?? "");
      const misses = new Map(attemptStats.map((stats) => [stats.itemId, stats.misses]));
      return parsed
        .map((item, position) => ({ item, position, misses: misses.get(item.id) ?? 0 }))
        .sort((a, b) => b.misses - a.misses || a.position - b.position)
        .map(({ item }) => item);
    },
    [attemptStats, contentJson, content],
  );
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [showScore, setShowScore] = useState(false);
  const [timed, setTimed] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

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

  const scorable = items;
  let correct = 0;
  for (const item of scorable) {
    const pick = selected[item.id];
    if (pick && pick.trim().toLowerCase() === item.answer.trim().toLowerCase()) {
      correct += 1;
    }
  }

  function toggleReveal(id: string) {
    setRevealed((prev) => ({ ...prev, [id]: !prev[id] }));
    setShowScore(false);
  }

  function revealAll() {
    const next: Record<string, boolean> = {};
    for (const item of items) next[item.id] = true;
    setRevealed(next);
  }

  function hideAll() {
    setRevealed({});
    setShowScore(false);
  }

  async function saveAttempt() {
    const answers = scorable
      .filter((item) => selected[item.id])
      .map((item) => ({ itemId: item.id, selectedAnswer: selected[item.id]! }));
    if (answers.length === 0) return;
    setSaveBusy(true);
    setSaveMessage(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/test-attempts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: viewRevision, answers }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { stats: AttemptStats[] };
      onAttemptStatsChange(data.stats);
      setSaveMessage(`Saved ${answers.length} answer${answers.length === 1 ? "" : "s"}.`);
    } catch (caught) {
      setSaveMessage(caught instanceof Error ? caught.message : "Could not save attempt.");
    } finally {
      setSaveBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={revealAll}>
          <Eye weight="bold" />
          Reveal answers
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setTimed(true)}>
          <Clock weight="bold" />
          Timed run
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={hideAll}>
          <EyeSlash weight="bold" />
          Hide answers
        </Button>
        {scorable.length > 0 ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setShowScore(true)}
          >
            Score locally
          </Button>
        ) : null}
        {scorable.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void saveAttempt()}
            disabled={saveBusy || !scorable.some((item) => Boolean(selected[item.id]))}
          >
            {saveBusy ? "Saving" : "Save attempt"}
          </Button>
        ) : null}
        {showScore && scorable.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {correct} of {scorable.length} questions correct
          </p>
        ) : null}
        {attemptStats.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {attemptStats.reduce((sum, item) => sum + item.misses, 0)} saved miss{attemptStats.reduce((sum, item) => sum + item.misses, 0) === 1 ? "" : "es"} to revisit
          </p>
        ) : null}
        {saveMessage ? <p role="status" className="text-xs text-muted-foreground">{saveMessage}</p> : null}
      </div>

      <ol className="space-y-3">
        {items.map((item, index) => {
          const isOpen = !!revealed[item.id];
          const pick = selected[item.id];
          const questionId = controlId(item.id, "question");
          const isCorrect =
            pick &&
            pick.trim().toLowerCase() === item.answer.trim().toLowerCase();

          return (
            <li
              key={item.id}
              className="rounded-xl border border-border/80 bg-surface/50 p-4 sm:p-5"
            >
              <div className="flex gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-3">
                  <div
                    id={questionId}
                    className="text-sm font-medium leading-relaxed text-foreground"
                  >
                    <MarkdownBody source={item.question} />
                  </div>

                  {item.choices ? (
                    <div
                      className="flex flex-col gap-2"
                      role="radiogroup"
                      aria-labelledby={questionId}
                    >
                      {item.choices.map((choice, choiceIndex) => {
                        const active = pick === choice;
                        const choiceId = controlId(item.id, `choice-${choiceIndex + 1}`);
                        return (
                          <button
                            key={choiceId}
                            id={choiceId}
                            name={controlId(item.id, "choices")}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            className={cn(
                              "min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                              active
                                ? "border-primary/50 bg-primary/10 text-foreground"
                                : "border-border/80 bg-background/40 text-muted-foreground hover:border-border hover:text-foreground",
                            )}
                            onClick={() => {
                              setSelected((prev) => ({
                                ...prev,
                                [item.id]: choice,
                              }));
                              setShowScore(false);
                            }}
                          >
                            <MarkdownBody source={choice} inline />
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
                        value={pick ?? ""}
                        onChange={(event) => {
                          setSelected((prev) => ({ ...prev, [item.id]: event.target.value }));
                          setShowScore(false);
                        }}
                        className="min-h-11 rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                        aria-labelledby={`${questionId} ${controlId(item.id, "answer-label")}`}
                      />
                    </label>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => toggleReveal(item.id)}
                    >
                      {isOpen ? (
                        <>
                          <EyeSlash weight="bold" />
                          Hide answer
                        </>
                      ) : (
                        <>
                          <Eye weight="bold" />
                          Show answer
                        </>
                      )}
                    </Button>
                    {showScore && pick ? (
                      isCorrect ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                          <CheckCircle weight="fill" />
                          Correct
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-destructive">
                          <XCircle weight="fill" />
                          Incorrect
                        </span>
                      )
                    ) : null}
                  </div>

                  {isOpen ? (
                    <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-3 text-sm">
                      <p className="font-medium text-foreground">
                        Answer: <MarkdownBody source={item.answer} inline />
                      </p>
                      {item.explanation ? (
                        <MarkdownBody source={item.explanation} />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
