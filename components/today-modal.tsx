"use client";

import Link from "next/link";
import { BookOpen, Cards, SunHorizon, Target } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DoFirstItem, PacingGroup, TodayPlan } from "@/lib/today-plan";

export type TodayHrefs = {
  review: (packId: string) => string;
  retest: (packId: string) => string;
  reread: (packId: string, sectionId: string) => string;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const percent = (score: number) => `${Math.round(score * 100)}% mastery`;

function utcLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
}

function DoFirstRow({
  icon,
  title,
  detail,
  action,
  href,
  primary,
  onNavigate,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action: string;
  href: string;
  primary?: boolean;
  onNavigate: () => void;
}) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2">
      <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-muted text-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="font-medium break-words">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <Button
        size="sm"
        variant={primary ? "default" : "outline"}
        nativeButton={false}
        render={<Link href={href} onClick={onNavigate} />}
      >
        {action}
      </Button>
    </li>
  );
}

function rowFor(item: DoFirstItem, hrefs: TodayHrefs, onNavigate: () => void) {
  if (item.kind === "review") {
    return (
      <DoFirstRow
        key="review"
        icon={<Cards weight="bold" className="size-4" />}
        title={`Review ${plural(item.dueCards, "due card", "due cards")}`}
        detail={plural(item.packCount, "pack", "packs")}
        action="Start"
        href={hrefs.review(item.packId)}
        primary
        onNavigate={onNavigate}
      />
    );
  }
  if (item.kind === "retest") {
    return (
      <DoFirstRow
        key={`retest-${item.packId}-${item.sectionId}`}
        icon={<Target weight="bold" className="size-4" />}
        title={`Re-test ${item.title}`}
        detail={`${percent(item.score)} · ${item.missed} missed last sitting`}
        action="Retry missed"
        href={hrefs.retest(item.packId)}
        onNavigate={onNavigate}
      />
    );
  }
  return (
    <DoFirstRow
      key={`reread-${item.packId}-${item.sectionId}`}
      icon={<BookOpen weight="bold" className="size-4" />}
      title={`Re-read: ${item.title}`}
      detail={`${percent(item.score)} · ${item.minutes} min read`}
      action="Open"
      href={hrefs.reread(item.packId, item.sectionId)}
      onNavigate={onNavigate}
    />
  );
}

export function PacingBlock({ group }: { group: PacingGroup }) {
  const todayDate = group.strip[0]?.date;
  return (
    <div className="grid min-w-0 max-w-full gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="font-medium">{group.topicName}</p>
        <p className="text-xs text-muted-foreground">
          {utcLabel(group.examDate, { month: "short", day: "numeric" })} · {plural(group.days, "day", "days")} ·{" "}
          {plural(group.packCount, "pack", "packs")}
        </p>
      </div>
      <ol className="grid min-w-0 max-w-full auto-cols-[minmax(2.75rem,1fr)] grid-flow-col gap-1.5 overflow-x-auto pb-1">
        {group.strip.map((day, index) => {
          const isToday = day.date === todayDate;
          const isExam = index === group.strip.length - 1 && group.days > 0;
          const label = isToday
            ? "Today"
            : isExam
              ? utcLabel(day.date, { month: "short", day: "numeric" })
              : utcLabel(day.date, { weekday: "short" });
          return (
            <li
              key={day.date}
              className={
                "flex min-w-0 flex-col items-center rounded-md px-1 py-1.5 text-[11px] " +
                (isExam ? "bg-destructive/15 text-foreground" : "bg-muted text-muted-foreground") +
                (isToday ? " outline-2 outline-primary" : "")
              }
            >
              <span className="max-w-full truncate">{label}</span>
              <span className="text-sm font-medium text-foreground">
                {day.newCards}
                <span className="sr-only"> new cards</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function TodayModal({
  plan,
  open,
  onOpenChange,
  hrefs,
  now,
}: {
  plan: TodayPlan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hrefs: TodayHrefs;
  /** Only for the header date; defaults to the current time when the dialog renders. */
  now?: Date;
}) {
  const close = () => onOpenChange(false);
  const date = (now ?? new Date()).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const description = plan.bar.minutes > 0 ? `${date} · about ${plan.bar.minutes} min` : date;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-x-hidden overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SunHorizon weight="bold" aria-hidden className="size-5 text-primary" />
            Today
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {plan.empty ? (
          <p className="border-t border-border pt-4">Nothing due today. Pick any pack to study.</p>
        ) : (
          <section aria-labelledby="today-do-first" className="border-t border-border pt-3">
            <h3
              id="today-do-first"
              className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase"
            >
              Do first
            </h3>
            <ul>{plan.doFirst.map((item) => rowFor(item, hrefs, close))}</ul>
          </section>
        )}

        {plan.pacing.length > 0 ? (
          <section aria-labelledby="today-pacing" className="grid min-w-0 gap-3 border-t border-border pt-3">
            <h3
              id="today-pacing"
              className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
            >
              Exam pacing
            </h3>
            {plan.pacing.map((group) => (
              <PacingBlock key={`${group.topicName}-${group.examDate}`} group={group} />
            ))}
            <p className="text-xs text-muted-foreground">
              New cards are spread so every card is seen at least twice before the exam.
            </p>
          </section>
        ) : null}

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">Want to study something else? Close this and pick any pack.</p>
          <Button variant="ghost" size="sm" onClick={close}>
            Just browse
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
