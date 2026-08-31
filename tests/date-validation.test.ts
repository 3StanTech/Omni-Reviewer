import { describe, expect, it } from "vitest";

import { isCalendarDate } from "@/lib/date-validation";

describe("calendar date validation", () => {
  it("accepts real dates and rejects impossible dates", () => {
    expect(isCalendarDate("2026-08-30")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-04-31")).toBe(false);
    expect(isCalendarDate("2026-1-1")).toBe(false);
  });
});
