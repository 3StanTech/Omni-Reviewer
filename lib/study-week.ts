const TIME_ZONE = "Asia/Manila";
const LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StudyDayState = "studied" | "today" | "today-studied" | "missed" | "future";

export type StudyWeek = {
  days: Array<{ date: string; label: (typeof LABELS)[number]; state: StudyDayState }>;
  streak: number;
  studiedThisWeek: number;
};

/** The Manila calendar date of an instant, as YYYY-MM-DD. */
export function manilaDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIME_ZONE,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A YYYY-MM-DD date moved by whole days (calendar arithmetic in UTC, no clock involved). */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The current Manila Mon-Sun week with each day's state, plus the streak. */
export function studyWeek(studyDays: readonly string[], now: Date): StudyWeek {
  const studied = new Set(studyDays);
  const today = manilaDate(now);
  const mondayOffset = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = shiftDate(today, -mondayOffset);

  const days = LABELS.map((label, index) => {
    const date = shiftDate(monday, index);
    const state: StudyDayState =
      date === today
        ? studied.has(date)
          ? "today-studied"
          : "today"
        : date > today
          ? "future"
          : studied.has(date)
            ? "studied"
            : "missed";
    return { date, label, state };
  });

  let streak = 0;
  let cursor = studied.has(today) ? today : shiftDate(today, -1);
  while (studied.has(cursor)) {
    streak += 1;
    cursor = shiftDate(cursor, -1);
  }

  const studiedThisWeek = days.filter((day) => day.state === "studied" || day.state === "today-studied").length;
  return { days, streak, studiedThisWeek };
}

/** "3-day streak" from two days up; otherwise the week's study-day count. */
export function streakLine(week: StudyWeek): string {
  if (week.streak >= 2) return `${week.streak}-day streak`;
  return `${week.studiedThisWeek} study ${week.studiedThisWeek === 1 ? "day" : "days"} this week`;
}
