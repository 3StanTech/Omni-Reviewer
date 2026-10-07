"use client";

import Link from "next/link";
import { CalendarCheck, CaretRight } from "@phosphor-icons/react";

import type { TodayHrefs } from "@/components/today-modal";
import { Button } from "@/components/ui/button";
import { todayBarSegments, type DoFirstItem, type TodayPlan } from "@/lib/today-plan";

/** Where Start studying goes: the first Do-first item's mode in its pack. */
export function startHref(item: DoFirstItem, hrefs: TodayHrefs): string {
  if (item.kind === "review") return hrefs.review(item.packId);
  if (item.kind === "retest") return hrefs.retest(item.packId);
  return hrefs.reread(item.packId, item.sectionId);
}

/** The desk's Today card: the summary, Start studying, and the full plan. Covers all topics. */
export function TodayCard({
  plan,
  hrefs,
  onOpenPlan,
}: {
  plan: TodayPlan;
  hrefs: TodayHrefs;
  onOpenPlan: () => void;
}) {
  const summary = plan.empty ? "Nothing due today" : todayBarSegments(plan.bar).join(" · ");
  const first = plan.doFirst[0];
  return (
    <section
      aria-label="Today"
      className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/8 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-base font-semibold">
          <CalendarCheck weight="bold" aria-hidden className="size-5 shrink-0 text-primary" />
          Today
        </p>
        <p className="mt-1 text-sm break-words text-muted-foreground">{summary}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
        {first ? (
          <Button nativeButton={false} className="min-h-11" render={<Link href={startHref(first, hrefs)} />}>
            Start studying
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          aria-haspopup="dialog"
          onClick={onOpenPlan}
        >
          See the plan
          <CaretRight weight="bold" data-icon="inline-end" />
        </Button>
      </div>
    </section>
  );
}
