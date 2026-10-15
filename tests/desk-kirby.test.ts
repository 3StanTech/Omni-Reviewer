import { describe, expect, it } from "vitest";

import { deskKirbyLook } from "@/lib/desk-kirby";

// Manila is UTC+8.
const base = {
  now: new Date("2026-10-15T04:00:00Z"), // Manila Oct 15 12:00
  birthday: null,
  firstRun: false,
  dueCards: 3,
};

const at = (iso: string) => ({ ...base, now: new Date(iso) });

describe("deskKirbyLook priority", () => {
  it("puts birthday before first run, first run before late night, late night before nothing due", () => {
    const lateEmpty = { ...at("2026-09-25T15:30:00Z"), dueCards: 0 }; // Manila Sept 25 23:30
    expect(deskKirbyLook({ ...lateEmpty, birthday: "09-25", firstRun: true })).toEqual({
      pose: "idle",
      accessory: "party",
      cake: true,
      belated: false,
    });
    expect(deskKirbyLook({ ...lateEmpty, firstRun: true })).toEqual({ pose: "point", accessory: null, cake: false, belated: false });
    expect(deskKirbyLook(lateEmpty)).toEqual({ pose: "yawn", accessory: null, cake: false, belated: false });
    expect(deskKirbyLook({ ...lateEmpty, now: base.now })).toEqual({ pose: "idle", accessory: "nightcap", cake: false, belated: false });
    expect(deskKirbyLook(base)).toEqual({ pose: "idle", accessory: null, cake: false, belated: false });
  });

  it("reads the birthday in Manila, not UTC", () => {
    // UTC Sept 25 16:30 is Manila Sept 26 00:30.
    expect(deskKirbyLook({ ...at("2026-09-25T16:30:00Z"), birthday: "09-26" }).accessory).toBe("party");
    expect(deskKirbyLook({ ...at("2026-09-25T15:59:00Z"), birthday: "09-26" }).accessory).toBeNull();
  });
});

describe("deskKirbyLook late night", () => {
  it("yawns from 23:00 to 03:59 Manila", () => {
    expect(deskKirbyLook(at("2026-10-15T14:59:00Z")).pose).toBe("idle"); // 22:59
    expect(deskKirbyLook(at("2026-10-15T15:00:00Z")).pose).toBe("yawn"); // 23:00
    expect(deskKirbyLook(at("2026-10-15T19:59:00Z")).pose).toBe("yawn"); // 03:59
    expect(deskKirbyLook(at("2026-10-15T20:00:00Z")).pose).toBe("idle"); // 04:00
  });
});

describe("deskKirbyLook due cards", () => {
  it("wears the nightcap only when nothing is due", () => {
    expect(deskKirbyLook({ ...base, dueCards: 0 }).accessory).toBe("nightcap");
    expect(deskKirbyLook({ ...base, dueCards: 1 }).accessory).toBeNull();
  });

  it("points at the guide on first run even with nothing due", () => {
    expect(deskKirbyLook({ ...base, firstRun: true, dueCards: 0 })).toEqual({ pose: "point", accessory: null, cake: false, belated: false });
  });
});

describe("deskKirbyLook belated birthday", () => {
  const birthday = "09-26";
  it("parties on first run 1 to 30 days after the birthday, Manila time", () => {
    const belated = { pose: "idle", accessory: "party", cake: true, belated: true };
    expect(deskKirbyLook({ ...at("2026-09-26T16:00:00Z"), birthday, firstRun: true })).toEqual(belated); // Sept 27 00:00
    expect(deskKirbyLook({ ...at("2026-10-26T15:59:00Z"), birthday, firstRun: true })).toEqual(belated); // Oct 26 23:59, day 30
    expect(deskKirbyLook({ ...at("2026-10-26T16:00:00Z"), birthday, firstRun: true }).pose).toBe("point"); // Oct 27, day 31
    expect(deskKirbyLook({ ...at("2026-09-26T04:00:00Z"), birthday, firstRun: true }).belated).toBe(false); // the day itself
  });

  it("needs first run and beats the late-night rule", () => {
    expect(deskKirbyLook({ ...at("2026-10-15T04:00:00Z"), birthday, firstRun: false }).accessory).toBeNull();
    expect(deskKirbyLook({ ...at("2026-10-15T15:30:00Z"), birthday, firstRun: true }).belated).toBe(true); // 23:30
  });

  it("counts across the new year", () => {
    expect(deskKirbyLook({ ...at("2027-01-05T04:00:00Z"), birthday: "12-20", firstRun: true }).belated).toBe(true);
  });
});
