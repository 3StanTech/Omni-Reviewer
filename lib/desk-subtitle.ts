/** Inputs for the desk subtitle; `birthday` is the user's "MM-DD" or null. */
export type DeskSubtitleInput = {
  now: Date;
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

  // The heading above already greets by name, so these lines don't repeat it.
  if (input.birthday && input.birthday === monthDay) return "Happy birthday 🎉 Study light today.";
  if (input.firstRun && isBelatedBirthday(input.now, input.birthday, timeZone)) {
    return "Belated Happy Birthday 🎉 Let's set up your first study pack.";
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

/** Days since the most recent birthday ("MM-DD") in the given zone; 0 on the day itself. */
export function daysSinceBirthday(now: Date, birthday: string, timeZone = "Asia/Manila"): number {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const today = Date.UTC(part("year"), part("month") - 1, part("day"));
  const [month, day] = birthday.split("-").map(Number);
  let last = Date.UTC(part("year"), month - 1, day);
  if (last > today) last = Date.UTC(part("year") - 1, month - 1, day);
  return Math.round((today - last) / 86_400_000);
}

/** Any day after the birthday until the next one (the day itself is a plain birthday). First run only, so it ends with the first pack. */
export function isBelatedBirthday(now: Date, birthday: string | null, timeZone = "Asia/Manila"): boolean {
  if (!birthday) return false;
  return daysSinceBirthday(now, birthday, timeZone) >= 1;
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
