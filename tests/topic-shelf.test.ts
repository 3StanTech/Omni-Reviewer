import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const EM_DASH = "\u2014";

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("topic shelf", () => {
  const shelf = read("components/topic-shelf.tsx");
  const shell = read("components/app-shell.tsx");
  const home = read("components/study-home.tsx");
  const page = read("app/page.tsx");

  it("is available as a collapsible library surface and is md+ only", () => {
    expect(shelf).toContain("hidden");
    expect(shelf).toContain("md:flex");
  });

  it("slots the shelf in AppShell and keeps mood control", () => {
    expect(shell).toContain("TopicShelf");
    expect(shell).toContain("MoodControl");
    expect(shell).toContain("topics={topics}");
    expect(shell).toContain("dueTodayCount={dueTodayCount}");
  });

  it("sums selected-topic dueTodayCount on home and labels Due today", () => {
    expect(page).toContain("dueTodayCount={dueTodayCount}");
    expect(page).toContain("sum + reviewer.dueTodayCount");
    expect(shelf).toContain("Due today");
    expect(shelf).toContain("{dueTodayCount}");
  });

  it("keeps TopicTabs on the home surface", () => {
    expect(home).toContain("TopicTabs");
  });

  it("uses Phosphor icons and does not put an em dash in shelf copy", () => {
    expect(shelf).toContain("@phosphor-icons/react");
    expect(shelf).not.toContain(EM_DASH);
    expect(shell).not.toContain(EM_DASH);
    expect(home).not.toContain(EM_DASH);
    expect(page).not.toContain(EM_DASH);
  });
});
