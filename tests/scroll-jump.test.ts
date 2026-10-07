import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scrollJumpState } from "@/components/scroll-jump";

const root = path.resolve(__dirname, "..");
const EM_DASH = "—";

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("scrollJumpState", () => {
  const viewport = 800;

  it("shows nothing on a short page", () => {
    expect(scrollJumpState({ scrollY: 0, viewport, docHeight: 2400, endTop: 2000 })).toEqual({
      show: false,
      up: false,
      down: false,
    });
  });

  it("shows only Jump to end at the top of a long page", () => {
    expect(scrollJumpState({ scrollY: 0, viewport, docHeight: 17600, endTop: 16000 })).toEqual({
      show: true,
      up: false,
      down: true,
    });
  });

  it("shows both in the middle of a long page", () => {
    expect(scrollJumpState({ scrollY: 8000, viewport, docHeight: 17600, endTop: 8000 })).toEqual({
      show: true,
      up: true,
      down: true,
    });
  });

  it("shows only Back to top at the end", () => {
    expect(scrollJumpState({ scrollY: 16000, viewport, docHeight: 17600, endTop: 700 })).toEqual({
      show: true,
      up: true,
      down: false,
    });
  });

  it("hides Jump to end without the study end sentinel", () => {
    expect(scrollJumpState({ scrollY: 8000, viewport, docHeight: 17600, endTop: null }).down).toBe(false);
  });
});

describe("ScrollJump source", () => {
  const src = read("components/scroll-jump.tsx");

  it("labels both buttons", () => {
    expect(src).toContain('aria-label="Back to top"');
    expect(src).toContain('aria-label="Jump to end"');
  });

  it("respects reduced motion, hides in print and while Ask is open", () => {
    expect(src).toContain("prefers-reduced-motion: reduce");
    expect(src).toContain("print-hide");
    expect(src).toMatch(/if \(ask\?\.isOpen\) return null/);
  });

  it("targets the study end sentinel in the mode tabs", () => {
    expect(src).toContain("[data-study-end]");
    expect(read("components/view-tabs.tsx")).toContain("<div data-study-end aria-hidden");
  });

  it("is mounted inside the focus and Ask providers", () => {
    const workspace = read("components/reviewer-workspace.tsx");
    const mount = workspace.indexOf("<ScrollJump />");
    expect(mount).toBeGreaterThan(workspace.indexOf("<FocusModeProvider>"));
    expect(mount).toBeLessThan(workspace.indexOf("</FocusModeProvider>"));
    expect(mount).toBeLessThan(workspace.indexOf("</AskProvider>"));
  });

  it("has no em dash", () => {
    expect(src).not.toContain(EM_DASH);
  });
});
