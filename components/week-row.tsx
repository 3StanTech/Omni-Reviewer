import { CafeTreat, type CafeTreatKind, type CafeTreatState, MaximTomato } from "@/components/kirby-art";
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

/* Dream Land: a Café treat per day (Mon shortcake through Sun pancakes) in place of the dot. */
const DAY_TREAT: Record<keyof typeof DAY_NAMES, CafeTreatKind> = {
  Mon: "shortcake",
  Tue: "pudding",
  Wed: "cookie",
  Thu: "parfait",
  Fri: "donut",
  Sat: "macaron",
  Sun: "pancakes",
};

const TREAT_STATE: Record<StudyDayState, CafeTreatState> = {
  studied: "full",
  "today-studied": "full",
  today: "outline",
  missed: "plate",
  future: "faint",
};

const TODAY_RING = "ring-2 ring-primary/50 ring-offset-2 ring-offset-card";

/** The week as one sentence: the studied days, then the streak line. */
export function weekRowLabel(week: StudyWeek): string {
  const studied = week.days
    .filter((day) => day.state === "studied" || day.state === "today-studied")
    .map((day) => DAY_NAMES[day.label]);
  const lead = studied.length > 0 ? `Studied ${studied.join(", ")}.` : "No study days yet this week.";
  return `${lead} ${streakLine(week)}.`;
}

/**
 * Seven Mon-Sun dots for the current Manila week, with the streak line. Dream Land swaps
 * the dots for Café treats and adds a Maxim Tomato beside a streak of three days or more.
 */
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
              className={cn("size-2.5 rounded-full dreamland:hidden", DOT_CLASS[day.state])}
            />
            <span
              className={cn(
                "hidden size-7 items-center justify-center rounded-full dreamland:flex",
                (day.state === "today" || day.state === "today-studied") && TODAY_RING,
              )}
            >
              <CafeTreat kind={DAY_TREAT[day.label]} state={TREAT_STATE[day.state]} className="w-6" />
            </span>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-1.5">
        {week.streak >= 3 ? (
          <span className="hidden w-6 shrink-0 dreamland:block">
            <MaximTomato />
          </span>
        ) : null}
        <p className="text-sm font-medium text-foreground">{streakLine(week)}</p>
      </div>
    </div>
  );
}
