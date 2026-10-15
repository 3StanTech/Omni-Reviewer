import { describe, expect, it } from "vitest";

import { manilaDate, streakLine, studyWeek } from "@/lib/study-week";

// Manila is UTC+8. 2026-10-12 is a Monday.
const states = (week: ReturnType<typeof studyWeek>) => week.days.map((day) => day.state);

describe("manilaDate", () => {
  it("rolls a UTC late evening into the next Manila day", () => {
    expect(manilaDate(new Date("2026-10-14T15:59:59Z"))).toBe("2026-10-14");
    expect(manilaDate(new Date("2026-10-14T16:00:00Z"))).toBe("2026-10-15");
  });
});

describe("studyWeek boundaries", () => {
  it("starts the week on Manila Monday 00:00", () => {
    const week = studyWeek([], new Date("2026-10-11T16:00:00Z")); // Mon Oct 12 00:00 Manila
    expect(week.days[0]).toEqual({ date: "2026-10-12", label: "Mon", state: "today" });
    expect(week.days[6]).toEqual({ date: "2026-10-18", label: "Sun", state: "future" });
  });

  it("keeps Manila Sunday 23:59 in the week before", () => {
    const week = studyWeek(["2026-10-05"], new Date("2026-10-11T15:59:00Z")); // Sun Oct 11 23:59 Manila
    expect(week.days[0].date).toBe("2026-10-05");
    expect(week.days[6]).toEqual({ date: "2026-10-11", label: "Sun", state: "today" });
    expect(states(week)).toEqual(["studied", "missed", "missed", "missed", "missed", "missed", "today"]);
  });

  it("marks today studied from an answer late on the UTC day before", () => {
    const now = new Date("2026-10-14T16:30:00Z"); // Thu Oct 15 00:30 Manila
    const week = studyWeek([manilaDate(new Date("2026-10-14T16:10:00Z"))], now);
    expect(states(week)).toEqual(["missed", "missed", "missed", "today-studied", "future", "future", "future"]);
  });
});

describe("streak", () => {
  const thursday = new Date("2026-10-15T04:00:00Z"); // Thu Oct 15 12:00 Manila

  it("runs through yesterday when today has no study yet", () => {
    const week = studyWeek(["2026-10-12", "2026-10-13", "2026-10-14"], thursday);
    expect(week.streak).toBe(3);
    expect(streakLine(week)).toBe("3-day streak");
  });

  it("extends when today is studied, across the week start", () => {
    const week = studyWeek(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"], thursday);
    expect(week.streak).toBe(6);
    expect(week.studiedThisWeek).toBe(4);
  });

  it("breaks at a gap and is 0 when yesterday is empty too", () => {
    const gap = studyWeek(["2026-10-12", "2026-10-14"], thursday);
    expect(gap.streak).toBe(1);
    expect(streakLine(gap)).toBe("2 study days this week");

    const broken = studyWeek(["2026-10-12", "2026-10-13"], thursday);
    expect(broken.streak).toBe(0);
    expect(streakLine(studyWeek(["2026-10-12"], thursday))).toBe("1 study day this week");
  });

  it("handles no study days", () => {
    const week = studyWeek([], thursday);
    expect(week.streak).toBe(0);
    expect(week.studiedThisWeek).toBe(0);
    expect(streakLine(week)).toBe("0 study days this week");
  });
});
