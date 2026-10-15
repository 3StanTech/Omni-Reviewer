import { describe, expect, it } from "vitest";

import { shouldCelebrate, type FirstFacts } from "@/lib/firsts";

const facts = (overrides: Partial<FirstFacts>): FirstFacts => ({
  generatedPacks: 0,
  completedSittings: 0,
  dueToday: 5,
  ...overrides,
});

describe("shouldCelebrate", () => {
  it("cheers only the first generated pack", () => {
    expect(shouldCelebrate("pack", facts({ generatedPacks: 1 }), false)).toBe(true);
    expect(shouldCelebrate("pack", facts({ generatedPacks: 2 }), false)).toBe(false);
    expect(shouldCelebrate("pack", facts({ generatedPacks: 0 }), false)).toBe(false);
  });

  it("cheers only the first completed sitting", () => {
    expect(shouldCelebrate("sitting", facts({ completedSittings: 1 }), false)).toBe(true);
    expect(shouldCelebrate("sitting", facts({ completedSittings: 3 }), false)).toBe(false);
    expect(shouldCelebrate("sitting", facts({ completedSittings: 0 }), false)).toBe(false);
  });

  it("cheers the all-due day only when nothing is left today", () => {
    expect(shouldCelebrate("all-due", facts({ dueToday: 0 }), false)).toBe(true);
    expect(shouldCelebrate("all-due", facts({ dueToday: 1 }), false)).toBe(false);
  });

  it("does not look at other kinds' facts", () => {
    expect(shouldCelebrate("pack", facts({ generatedPacks: 1, completedSittings: 4, dueToday: 0 }), false)).toBe(true);
    expect(shouldCelebrate("sitting", facts({ generatedPacks: 1, dueToday: 0 }), false)).toBe(false);
  });

  it("never cheers once the device flag is set", () => {
    expect(shouldCelebrate("pack", facts({ generatedPacks: 1 }), true)).toBe(false);
    expect(shouldCelebrate("sitting", facts({ completedSittings: 1 }), true)).toBe(false);
    expect(shouldCelebrate("all-due", facts({ dueToday: 0 }), true)).toBe(false);
  });
});
