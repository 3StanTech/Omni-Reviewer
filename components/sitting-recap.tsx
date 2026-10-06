"use client";

import { CheckCircle } from "@phosphor-icons/react";
import { useId, type ReactNode } from "react";

type SittingRecapProps = {
  title: string;
  /** Stat lines; the first is the headline. */
  lines: string[];
  /** The section most missed this sitting. */
  focusSection?: string | null;
  /** When rated cards come back. */
  returns?: string | null;
  children?: ReactNode;
};

/** The end-of-sitting summary card shared by the study modes. */
export function SittingRecap({ title, lines, focusSection, returns, children }: SittingRecapProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border/80 bg-surface/50 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <CheckCircle weight="fill" className="recap-check size-5 shrink-0 text-success" aria-hidden />
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
      </div>
      <div className="mt-3 space-y-1" aria-live="polite">
        {lines.map((line, index) => (
          <p key={index} className={index === 0 ? "text-sm font-medium text-foreground" : "text-sm text-muted-foreground"}>
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
