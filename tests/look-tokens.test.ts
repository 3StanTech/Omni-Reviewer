import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const EM_DASH = "\u2014";

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("look tokens and mood control", () => {
  const css = read("app/globals.css");
  const mood = read("components/mood-control.tsx");
  const provider = read("components/look-provider.tsx");
  const layout = read("app/layout.tsx");
  const shell = read("components/app-shell.tsx");

  it("defines the two approved look token blocks", () => {
    expect(css).toContain('[data-look="day"]');
    expect(css).toContain('[data-look="night"]');
  });

  it("keeps the graphite night and white day tokens", () => {
    const nightBlockStart = css.indexOf('[data-look="night"]');
    const dayBlockStart = css.indexOf('[data-look="day"]');
    expect(nightBlockStart).toBeGreaterThan(-1);
    expect(dayBlockStart).toBeGreaterThan(nightBlockStart);
    const nightBlock = css.slice(nightBlockStart, dayBlockStart);
    expect(nightBlock).toContain("oklch(0.14 0.025 250)");
    expect(nightBlock).toContain("oklch(0.75 0.13 180)");
    expect(css).toContain("--background: #ffffff");
    const dayBlock = css.slice(dayBlockStart);
    expect(nightBlock).toContain("--font-ui: var(--font-plex)");
    expect(dayBlock).toContain("--font-ui: var(--font-plex)");
    expect(dayBlock).toContain("--font-reading: var(--font-serif)");
    expect(nightBlock).not.toContain("--border: oklch(0.34 0.035 245 / 65%)");
  });

  it("uses the exact mood copy and exposes only Day and Night", () => {
    expect(mood).toContain("Change today's mood");
    const day = mood.indexOf('"Day"');
    const night = mood.indexOf('"Night"');
    expect(day).toBeGreaterThan(-1);
    expect(night).toBeGreaterThan(day);
    expect(mood).not.toContain("Thea-Style");
    expect(mood).not.toContain("RemNote-Style");
    expect(shell).toContain("MoodControl");
  });

  it("defaults to night, persists omni-look, and toggles dark only for night", () => {
    expect(provider).toContain('LookId = "day" | "night"');
    expect(provider).toContain('"day"');
    expect(provider).toContain('"night"');
    expect(provider).toContain("normalizeLook");
    expect(provider).toContain('DEFAULT_LOOK: LookId = "night"');
    expect(provider).toContain('LOOK_STORAGE_KEY = "omni-look"');
    expect(provider).toContain("dataset.look");
    expect(provider).toContain('root.classList.toggle("dark", look === "night")');
    expect(layout).toContain('data-look="night"');
    expect(layout).toContain("LookProvider");
    expect(layout).not.toContain("DM_Sans");
    expect(layout).not.toContain("Source_Sans_3");
  });

  it("does not put an em dash in new look or mood strings", () => {
    expect(mood).not.toContain(EM_DASH);
    expect(provider).not.toContain(EM_DASH);
    expect(shell).not.toContain(EM_DASH);
  });

  it("drops the night lamp wash on light looks", () => {
    expect(css).toContain('html[data-look="day"] body');
    expect(css).toContain("background-image: none");
  });
});
