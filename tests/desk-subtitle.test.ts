import { describe, expect, it } from "vitest";

import { deskSubtitle, parseBirthdayDates } from "@/lib/desk-subtitle";

// Manila is UTC+8.
const base = {
  now: new Date("2026-10-15T04:00:00Z"), // Manila 12:00
  birthday: null,
  firstRun: false,
  reviewCards: 0,
  newCards: 0,
  minutes: 0,
};

describe("deskSubtitle priority", () => {
  it("puts birthday before first run, first run before late night, late night before due", () => {
    const lateDue = { ...base, now: new Date("2026-09-25T15:30:00Z"), reviewCards: 3, minutes: 4 }; // Sept 25 23:30
    expect(deskSubtitle({ ...lateDue, birthday: "09-25", firstRun: true })).toBe(
      "Happy birthday 🎉 Study light today.",
    );
    expect(deskSubtitle({ ...lateDue, firstRun: true })).toBe("Let's set up your first study pack.");
    expect(deskSubtitle(lateDue)).toBe("It's late. A short session, then sleep.");
    expect(deskSubtitle({ ...lateDue, now: base.now })).toBe("3 cards waiting, about 4 minutes.");
    expect(deskSubtitle(base)).toBe("All caught up! Nothing due today.");
  });
});

describe("deskSubtitle Manila boundaries", () => {
  const due = { ...base, newCards: 2, minutes: 3 };
  const dueLine = "2 cards waiting, about 3 minutes.";
  const late = "It's late. A short session, then sleep.";

  it("starts late night at 23:00 and ends it after 03:59", () => {
    expect(deskSubtitle({ ...due, now: new Date("2026-10-15T14:59:00Z") })).toBe(dueLine); // 22:59
    expect(deskSubtitle({ ...due, now: new Date("2026-10-15T15:00:00Z") })).toBe(late); // 23:00
    expect(deskSubtitle({ ...due, now: new Date("2026-10-15T19:59:00Z") })).toBe(late); // 03:59
    expect(deskSubtitle({ ...due, now: new Date("2026-10-15T20:00:00Z") })).toBe(dueLine); // 04:00
  });

  it("matches the birthday on the Manila date, not the UTC date", () => {
    const sept26 = { ...base, birthday: "09-26" };
    const birthday = "Happy birthday 🎉 Study light today.";
    expect(deskSubtitle({ ...sept26, now: new Date("2026-09-25T23:30:00Z") })).toBe(birthday); // Sept 26 07:30
    expect(deskSubtitle({ ...sept26, now: new Date("2026-09-25T15:59:00Z") })).not.toBe(birthday); // Sept 25 23:59
    expect(deskSubtitle({ ...sept26, now: new Date("2026-09-26T15:59:00Z") })).toBe(birthday); // Sept 26 23:59
    expect(deskSubtitle({ ...sept26, now: new Date("2026-09-26T16:00:00Z") })).not.toBe(birthday); // Sept 27 00:00
  });
});

describe("deskSubtitle due copy", () => {
  it("says card for one and leaves out zero minutes", () => {
    expect(deskSubtitle({ ...base, reviewCards: 1, minutes: 1 })).toBe("1 card waiting, about 1 minute.");
    expect(deskSubtitle({ ...base, reviewCards: 4, newCards: 1 })).toBe("5 cards waiting.");
  });
});

describe("parseBirthdayDates", () => {
  it("keeps well-formed pairs and ignores malformed ones", () => {
    const dates = parseBirthdayDates(" user-a=09-26 , bad, =01-02, user-b=13-01, user-c=02-30x, user-d=9-26, user-e=a=01-01,user-f=02-29 ");
    expect([...dates]).toEqual([
      ["user-a", "09-26"],
      ["user-f", "02-29"],
    ]);
  });

  it("returns an empty map without a value", () => {
    expect(parseBirthdayDates(undefined).size).toBe(0);
    expect(parseBirthdayDates("").size).toBe(0);
  });
});

describe("deskSubtitle belated birthday", () => {
  it("greets any first run after the birthday, before the plain first-run line", () => {
    const firstRun = { ...base, firstRun: true, birthday: "09-26" }; // base is Oct 15, day 19
    expect(deskSubtitle(firstRun)).toBe("Belated Happy Birthday 🎉 Let's set up your first study pack.");
    expect(deskSubtitle({ ...firstRun, now: new Date("2026-10-26T16:00:00Z") })).toBe("Belated Happy Birthday 🎉 Let's set up your first study pack."); // day 31
    expect(deskSubtitle({ ...firstRun, firstRun: false })).toBe("All caught up! Nothing due today.");
  });
});
