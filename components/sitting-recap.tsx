"use client";

import { CheckCircle } from "@phosphor-icons/react";
import { useId, type ReactNode } from "react";

type SittingRecapProps = {
  title: string;
  /** Stat lines; the first is the headline unless `score` is given. */
  lines: string[];
  /** A large "correct/total" score with its percent, above the lines. */
  score?: { correct: number; total: number };
  /** The section most missed this sitting. */
  focusSection?: string | null;
  /** When rated cards come back. */
  returns?: string | null;
  children?: ReactNode;
};

/** The end-of-sitting summary card shared by the study modes. */
export function SittingRecap({ title, lines, score, focusSection, returns, children }: SittingRecapProps) {
  const headingId = useId();
  const percent = score && score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0;
  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border/80 bg-surface/50 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <CheckCircle weight="fill" className="recap-check size-5 shrink-0 text-success" aria-hidden />
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
      </div>
      <div className="mt-3 space-y-1" aria-live="polite">
        {score ? (
          <p className="flex items-baseline gap-2">
            <span aria-hidden className="text-3xl font-semibold tabular-nums text-foreground">
              {score.correct}/{score.total}
            </span>
            <span aria-hidden className="text-sm tabular-nums text-muted-foreground">{percent}%</span>
            <span className="sr-only">{`${score.correct} of ${score.total} correct, ${percent} percent`}</span>
          </p>
        ) : null}
        {lines.map((line, index) => (
          <p key={index} className={index === 0 && !score ? "text-sm font-medium text-foreground" : "text-sm text-muted-foreground"}>
            {line}
          </p>
        ))}
      </div>
      {focusSection ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Look at next: <span className="text-foreground">{focusSection}</span>
        </p>
      ) : null}
      {returns ? <p className="mt-1 text-sm text-muted-foreground">{returns}</p> : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}
