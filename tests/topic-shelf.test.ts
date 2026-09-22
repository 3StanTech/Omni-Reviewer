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
  const reviewer = read("app/topics/[topicId]/reviewers/[reviewerId]/page.tsx");

  it("toggles from a header button and remembers the choice", () => {
    expect(shelf).toContain("omni-topic-shelf");
    expect(shelf).toContain('aria-label="Topics"');
    expect(shelf).toContain("aria-expanded");
    expect(shelf).toContain("aria-controls");
    expect(shelf).toContain('id={TOPIC_SHELF_ID}');
    expect(shell).toContain("TopicShelfToggle");
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

  it("keeps TopicTabs on the home surface and the shelf on a study pack", () => {
    expect(home).toContain("TopicTabs");
    expect(reviewer).toContain("topics={topics.map");
    expect(reviewer).not.toContain("showTopicShelf={false}");
  });

  it("uses Phosphor icons and does not put an em dash in shelf copy", () => {
    expect(shelf).toContain("@phosphor-icons/react");
    expect(shelf).not.toContain(EM_DASH);
    expect(shell).not.toContain(EM_DASH);
    expect(home).not.toContain(EM_DASH);
    expect(page).not.toContain(EM_DASH);
  });
});
