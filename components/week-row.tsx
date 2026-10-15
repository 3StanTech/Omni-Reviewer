import { streakLine, type StudyDayState, type StudyWeek } from "@/lib/study-week";
import { cn } from "@/lib/utils";

const DAY_NAMES = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
} as const;

const DOT_CLASS: Record<StudyDayState, string> = {
  studied: "bg-primary",
  "today-studied": "bg-primary ring-2 ring-primary/50 ring-offset-2 ring-offset-card",
  today: "bg-muted-foreground/25 ring-2 ring-primary/50 ring-offset-2 ring-offset-card",
  missed: "bg-muted-foreground/25",
  future: "bg-muted-foreground/10",
};

/** The week as one sentence: the studied days, then the streak line. */
export function weekRowLabel(week: StudyWeek): string {
  const studied = week.days
    .filter((day) => day.state === "studied" || day.state === "today-studied")
    .map((day) => DAY_NAMES[day.label]);
  const lead = studied.length > 0 ? `Studied ${studied.join(", ")}.` : "No study days yet this week.";
  return `${lead} ${streakLine(week)}.`;
}

/** Seven Mon-Sun dots for the current Manila week, with the streak line. */
export function WeekRow({ week }: { week: StudyWeek }) {
  return (
    <div
      role="img"
      aria-label={weekRowLabel(week)}
      className="print-hide flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <ol className="flex gap-1.5">
        {week.days.map((day) => (
          <li key={day.date} className="flex w-7 flex-col items-center gap-1">
            <span className="text-xs text-muted-foreground">{day.label}</span>
            <span
              data-day-state={day.state}
              className={cn("size-2.5 rounded-full", DOT_CLASS[day.state])}
            />
          </li>
        ))}
      </ol>
      <p className="text-sm font-medium text-foreground">{streakLine(week)}</p>
    </div>
  );
}
