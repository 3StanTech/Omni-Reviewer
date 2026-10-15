import { isBelatedBirthday } from "@/lib/desk-subtitle";

/** Inputs for the desk Kirby's look; `birthday` is the user's "MM-DD" or null. */
export type DeskKirbyInput = {
  now: Date;
  birthday: string | null;
  firstRun: boolean;
  dueCards: number;
  timeZone?: string;
};

export type DeskKirbyLook = {
  pose: "idle" | "point" | "yawn";
  accessory: "party" | "nightcap" | null;
  cake: boolean;
  /** First run within 30 days after the birthday: the desk greets with a belated birthday dance. */
  belated: boolean;
};

/**
 * The desk Kirby's pose and accessory: the first rule that applies, in the same order as
 * the desk subtitle (birthday, belated birthday on first run, first run, late night, nothing
 * due), in Manila time.
 */
export function deskKirbyLook(input: DeskKirbyInput): DeskKirbyLook {
  const timeZone = input.timeZone ?? "Asia/Manila";
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(input.now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(part("hour"));
  const plain = { cake: false, belated: false };

  if (input.birthday && input.birthday === `${part("month")}-${part("day")}`) {
    return { pose: "idle", accessory: "party", cake: true, belated: false };
  }
  if (input.firstRun && isBelatedBirthday(input.now, input.birthday, timeZone)) {
    return { pose: "idle", accessory: "party", cake: true, belated: true };
  }
  if (input.firstRun) return { pose: "point", accessory: null, ...plain };
  if (hour >= 23 || hour <= 3) return { pose: "yawn", accessory: null, ...plain };
  if (input.dueCards === 0) return { pose: "idle", accessory: "nightcap", ...plain };
  return { pose: "idle", accessory: null, ...plain };
}
