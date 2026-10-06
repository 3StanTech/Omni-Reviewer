"use client";

import Link from "next/link";
import {
  ArrowClockwise,
  CircleNotch,
  Clock,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import {
  QUEUE_MIN_REQUESTS,
  queueRowLabel,
  resetCopy,
  type QueueRowState,
} from "@/lib/generation-queue";
import type { QueueRow, useGenerationQueue } from "@/lib/use-generation-queue";
import { cn } from "@/lib/utils";

type GenerationQueuePanelProps = Pick<
  ReturnType<typeof useGenerationQueue>,
  "rows" | "status" | "remove" | "retry" | "checkAgain"
>;

function RowIcon({ state }: { state: QueueRowState }) {
  const className = "size-4 shrink-0";
  switch (state.kind) {
    case "uploading":
    case "reading":
    case "generating":
      return (
        <CircleNotch
          aria-hidden
          className={cn(className, "animate-spin text-primary motion-reduce:animate-none")}
          weight="bold"
        />
      );
    case "queued":
    case "waiting":
      return <Clock aria-hidden className={cn(className, "text-muted-foreground")} weight="bold" />;
    case "failed":
    case "unreadable":
      return <WarningCircle aria-hidden className={cn(className, "text-warning")} weight="bold" />;
  }
}

function canRemove(row: QueueRow): boolean {
  return row.reviewerId !== null
    && row.state.kind !== "generating"
    && row.state.kind !== "uploading"
    && row.state.kind !== "reading";
}

/** The Study desk's queue of packs made from files. Hidden while empty. */
export function GenerationQueuePanel({
  rows,
  status,
  remove,
  retry,
  checkAgain,
}: GenerationQueuePanelProps) {
  if (rows.length === 0 && status.skipped.length === 0 && !status.error) return null;
  const { quota } = status;
  const generating = rows.find((row) => row.state.kind === "generating") ?? null;

  return (
    <section
      aria-labelledby="generation-queue-title"
      className="space-y-3 rounded-xl border border-border/80 bg-surface/40 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="generation-queue-title"
          className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          Generating queue
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {quota && quota.remaining !== null && quota.limit !== null ? (
            <p
              className={cn(
                "text-xs",
                quota.remaining < QUEUE_MIN_REQUESTS ? "text-warning" : "text-muted-foreground",
              )}
            >
              {quota.remaining} of {quota.limit} free requests left today
            </p>
          ) : null}
          {status.waiting ? (
            <Button type="button" variant="ghost" size="xs" onClick={checkAgain}>
              <ArrowClockwise />
              Check again
            </Button>
          ) : null}
        </div>
      </div>

      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {status.waiting
          ? `Packs generate one at a time while this page is open · Waiting for tomorrow's free requests (${resetCopy()})`
          : generating
            ? `${generating.name} · ${queueRowLabel(generating.state)}`
            : null}
      </p>
      {status.skipped.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Skipped {status.skipped.join(" · ")}. Only PDF, Word, PowerPoint, text and
          Markdown files make packs.
        </p>
      ) : null}
      {status.error ? (
        <p role="alert" className="text-xs text-destructive">
          {status.error}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="divide-y divide-border/70">
          {rows.map((row) => (
            <li key={row.key} className="flex min-h-11 items-center gap-3 py-2">
              <RowIcon state={row.state} />
              <span className="min-w-0 flex-1">
                {row.reviewerId ? (
                  <Link
                    href={`/topics/${row.topicId}/reviewers/${row.reviewerId}`}
                    className="block truncate text-sm font-medium text-foreground hover:underline"
                  >
                    {row.name}
                  </Link>
                ) : (
                  <span className="block truncate text-sm font-medium text-foreground">
                    {row.name}
                  </span>
                )}
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {queueRowLabel(row.state)}
                  {row.message ? ` · ${row.message}` : null}
                </span>
              </span>
              {row.state.kind === "failed" && row.reviewerId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void retry(row.reviewerId!)}
                >
                  <ArrowClockwise />
                  Retry
                </Button>
              ) : null}
              {canRemove(row) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${row.name} from the queue`}
                  title="Remove from queue"
                  onClick={() => void remove(row.reviewerId!)}
                >
                  <X weight="bold" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
