"use client";

import Link from "next/link";
import { Fragment, useId } from "react";
import { CalendarCheck, CaretRight } from "@phosphor-icons/react";

import type { TodayHrefs } from "@/components/today-modal";
import { StudyHelp } from "@/components/study-help";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { WeekRow } from "@/components/week-row";
import {
  todayBarParts,
  WEAK_SECTION_DEFINITION,
  type DoFirstItem,
  type TodayBarData,
  type TodayPlan,
} from "@/lib/today-plan";
import type { StudyWeek } from "@/lib/study-week";

/** Where Start studying goes: the first Do-first item's mode in its pack. */
export function startHref(item: DoFirstItem, hrefs: TodayHrefs): string {
  if (item.kind === "review") return hrefs.review(item.packId);
  if (item.kind === "retest") return hrefs.retest(item.packId);
  return hrefs.reread(item.packId, item.sectionId);
}

type TodayStat = { value: string; label: string; weak?: boolean };

/** The card's stat columns, in the summary's order; a zero part is left out. */
function todayStats(bar: TodayBarData): TodayStat[] {
  const stats: TodayStat[] = [];
  if (bar.reviewCards > 0) stats.push({ value: String(bar.reviewCards), label: "to review" });
  if (bar.newCards > 0) stats.push({ value: String(bar.newCards), label: "new" });
  if (bar.weakSections > 0) {
    stats.push({
      value: String(bar.weakSections),
      label: bar.weakSections === 1 ? "weak section" : "weak sections",
      weak: true,
    });
  }
  if (bar.exam) {
    stats.push(
      bar.exam.days === 0
        ? { value: "Today", label: `${bar.exam.topicName} exam` }
        : {
            value: String(bar.exam.days),
            label: `${bar.exam.days === 1 ? "day" : "days"} to ${bar.exam.topicName} exam`,
          },
    );
  }
  if (bar.minutes > 0) stats.push({ value: `~${bar.minutes}`, label: "minutes" });
  return stats;
}

/** The desk's Today card: the summary, Start studying, and the full plan. Covers all topics. */
export function TodayCard({
  plan,
  hrefs,
  onOpenPlan,
  week,
}: {
  plan: TodayPlan;
  hrefs: TodayHrefs;
  onOpenPlan: () => void;
  /** The Manila study week; the row is left out without it. */
  week?: StudyWeek;
}) {
  const weakDefinitionId = useId();
  const parts = plan.empty ? [] : todayBarParts(plan.bar);
  const stats = plan.empty ? [] : todayStats(plan.bar);
  const first = plan.doFirst[0];
  return (
    <Panel aria-label="Today">
      <PanelHeader
        label="Today"
        icon={<CalendarCheck weight="bold" aria-hidden className="size-4 shrink-0" />}
        actions={<span className="text-xs font-medium text-muted-foreground">All topics</span>}
        wrapLabel
      />
      <div className="flex flex-wrap items-center gap-4 p-4">
        {plan.empty ? (
          <p className="text-sm text-muted-foreground">Nothing due today</p>
        ) : (
          <>
            {/* The summary as one sentence for screen readers; the columns below show it. */}
            <p className="sr-only">
              {parts.map((part, index) => (
                <Fragment key={part.text}>
                  {index > 0 ? " · " : null}
                  {part.weak ? (
                    <span title={WEAK_SECTION_DEFINITION} aria-describedby={weakDefinitionId}>
                      {part.text}
                    </span>
                  ) : (
                    part.text
                  )}
                </Fragment>
              ))}
              {parts.some((part) => part.weak) ? (
                <span id={weakDefinitionId} hidden>
                  {WEAK_SECTION_DEFINITION}
                </span>
              ) : null}
            </p>
            <div aria-hidden className="flex min-w-0 flex-wrap gap-y-3">
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  className="min-w-0 border-l border-divider px-4 first:border-l-0 first:pl-0 max-sm:px-3 max-sm:first:pl-0"
                  title={stat.weak ? WEAK_SECTION_DEFINITION : undefined}
                >
                  <p className="text-[1.375rem] leading-tight font-bold tabular-nums break-words text-foreground">
                    {stat.value}
                  </p>
                  <p className="text-xs break-words text-muted-foreground">{stat.label}</p>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="flex flex-wrap items-center gap-1.5 md:ml-auto max-md:w-full">
          {first ? (
            <Button nativeButton={false} className="min-h-11" render={<Link href={startHref(first, hrefs)} />}>
              Start studying
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-haspopup="dialog"
            onClick={onOpenPlan}
          >
            See the plan
            <CaretRight weight="bold" data-icon="inline-end" />
          </Button>
          <StudyHelp />
        </div>
      </div>
      {week ? (
        <div className="print-hide border-t border-divider px-4 py-3">
          <WeekRow week={week} />
        </div>
      ) : null}
    </Panel>
  );
}
