import { describe, expect, it } from "vitest";

import { greetingFor } from "@/lib/greeting";

const at = (iso: string) => new Date(iso);

describe("greetingFor", () => {
  it("uses Manila hour boundaries", () => {
    // Manila is UTC+8.
    expect(greetingFor("Yana", at("2026-10-06T20:59:00Z"))).toBe("Good evening, Yana"); // 04:59
    expect(greetingFor("Yana", at("2026-10-06T21:00:00Z"))).toBe("Good morning, Yana"); // 05:00
    expect(greetingFor("Yana", at("2026-10-07T03:59:00Z"))).toBe("Good morning, Yana"); // 11:59
    expect(greetingFor("Yana", at("2026-10-07T04:00:00Z"))).toBe("Good afternoon, Yana"); // 12:00
    expect(greetingFor("Yana", at("2026-10-07T09:59:00Z"))).toBe("Good afternoon, Yana"); // 17:59
    expect(greetingFor("Yana", at("2026-10-07T10:00:00Z"))).toBe("Good evening, Yana"); // 18:00
    expect(greetingFor("Yana", at("2026-10-06T16:00:00Z"))).toBe("Good evening, Yana"); // 00:00
  });

  it("respects an explicit time zone", () => {
    expect(greetingFor("Yana", at("2026-10-06T21:00:00Z"), "UTC")).toBe("Good evening, Yana");
  });

  it("uses the first name only", () => {
    expect(greetingFor("  Yana Dela Cruz ", at("2026-10-07T04:00:00Z"))).toBe(
      "Good afternoon, Yana",
    );
    expect(greetingFor("Yana\tCruz", at("2026-10-07T04:00:00Z"))).toBe("Good afternoon, Yana");
  });

  it("returns null without a usable name", () => {
    const now = at("2026-10-07T04:00:00Z");
    expect(greetingFor("", now)).toBeNull();
    expect(greetingFor("   ", now)).toBeNull();
    expect(greetingFor(null, now)).toBeNull();
    expect(greetingFor(undefined, now)).toBeNull();
  });
});
