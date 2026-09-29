"use client";

import { CalendarCheck, CaretRight } from "@phosphor-icons/react";

import { todayBarSegments, type TodayPlan } from "@/lib/today-plan";

/** One line above the packs. Never blocks; the whole bar opens the Today plan. */
export function TodayBar({ plan, onOpen }: { plan: TodayPlan; onOpen: () => void }) {
  const summary = plan.empty ? "Nothing due today" : todayBarSegments(plan.bar).join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      title={summary}
      className="flex min-h-11 w-full items-center gap-2.5 rounded-xl border border-primary/40 bg-primary/8 px-4 py-2 text-left text-sm transition-colors outline-none hover:bg-primary/12 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
    >
      <CalendarCheck weight="bold" aria-hidden className="size-4 shrink-0 text-primary" />
      {plan.empty ? null : <span className="shrink-0 font-semibold">Today</span>}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
      <CaretRight weight="bold" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
