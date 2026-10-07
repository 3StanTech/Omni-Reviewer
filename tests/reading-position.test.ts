import { describe, expect, it } from "vitest";

import { currentHeadingIndex, readingProgress } from "@/lib/reading-position";

describe("currentHeadingIndex", () => {
  it("is -1 without headings or before the first", () => {
    expect(currentHeadingIndex([], 300)).toBe(-1);
    expect(currentHeadingIndex([400, 900], 300)).toBe(-1);
  });

  it("picks the last heading at or above the threshold", () => {
    expect(currentHeadingIndex([-500, 120, 700], 300)).toBe(1);
    expect(currentHeadingIndex([-900, -400, -100], 300)).toBe(2);
  });

  it("counts a heading exactly at the threshold", () => {
    expect(currentHeadingIndex([100, 300, 301], 300)).toBe(1);
  });
});

describe("readingProgress", () => {
  it("is 0 before the document reaches the top", () => {
    expect(readingProgress({ start: 200, end: 5200, viewport: 900 })).toBe(0);
    expect(readingProgress({ start: 0, end: 5000, viewport: 900 })).toBe(0);
  });

  it("is proportional in the middle", () => {
    // span = 5000 - 0 - 1000 = 4000 at start 0; scrolled 2000 of it.
    expect(readingProgress({ start: -2000, end: 3000, viewport: 1000 })).toBe(50);
  });

  it("is 100 once the end is in view", () => {
    expect(readingProgress({ start: -4100, end: 900, viewport: 900 })).toBe(100);
    expect(readingProgress({ start: -4500, end: 400, viewport: 900 })).toBe(100);
  });

  it("is 100 for a document shorter than the viewport", () => {
    expect(readingProgress({ start: 100, end: 600, viewport: 900 })).toBe(100);
  });
});
