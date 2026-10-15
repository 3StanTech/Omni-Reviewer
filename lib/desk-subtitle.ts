/** Inputs for the desk subtitle; `birthday` is the user's "MM-DD" or null. */
export type DeskSubtitleInput = {
  now: Date;
  firstName: string | null;
  birthday: string | null;
  firstRun: boolean;
  reviewCards: number;
  newCards: number;
  minutes: number;
  timeZone?: string;
};

/** The desk subtitle: the first rule that applies, in priority order. */
export function deskSubtitle(input: DeskSubtitleInput): string {
  const timeZone = input.timeZone ?? "Asia/Manila";
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(input.now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const monthDay = `${part("month")}-${part("day")}`;
  const hour = Number(part("hour"));

  if (input.birthday && input.birthday === monthDay) {
    const name = input.firstName?.trim();
    return name ? `Happy birthday, ${name}! Study light today.` : "Happy birthday! Study light today.";
  }
  if (input.firstRun) return "Let's set up your first study pack.";
  if (hour >= 23 || hour <= 3) return "It's late. A short session, then sleep.";
  const cards = input.reviewCards + input.newCards;
  if (cards > 0) {
    const waiting = `${cards} ${cards === 1 ? "card" : "cards"} waiting`;
    return input.minutes > 0 ? `${waiting}, about ${input.minutes} ${input.minutes === 1 ? "minute" : "minutes"}.` : `${waiting}.`;
  }
  return "All caught up! Nothing due today.";
}

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Parses `BIRTHDAY_DATES` ("<userId>=MM-DD" pairs, comma-separated); malformed entries are ignored. */
export function parseBirthdayDates(raw: string | undefined): Map<string, string> {
  const dates = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const [userId, monthDay, ...rest] = entry.split("=").map((s) => s.trim());
    if (!userId || !monthDay || rest.length > 0 || !MONTH_DAY.test(monthDay)) continue;
    dates.set(userId, monthDay);
  }
  return dates;
}
