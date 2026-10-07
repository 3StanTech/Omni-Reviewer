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
    expect(shell).toContain("dueByTopic={dueByTopic}");
    expect(shell).toContain("dueTodayTotal={dueTodayTotal}");
  });

  it("totals Due today across every topic from listDueByTopic, on home and on a pack", () => {
    for (const source of [page, reviewer]) {
      expect(source).toContain("listDueByTopic(userId)");
      expect(source).toContain("dueByTopic={dueByTopic}");
      expect(source).toContain("dueTodayTotal={dueTodayTotal}");
      expect(source).not.toContain("dueTodayCount={");
    }
    expect(page).not.toContain("sum + reviewer.dueTodayCount");
    expect(shelf).toContain("Due today");
    expect(shelf).toContain("{dueTodayTotal}");
  });

  it("shows each topic's own due count and a 44px actions button on touch", () => {
    expect(shelf).toContain("dueByTopic?.[topic.id]");
    expect(shelf).toContain("aria-label={`${due} due today`}");
    expect(shelf).toContain("pointer-coarse:size-11");
    expect(read("components/topic-tabs.tsx")).toContain("pointer-coarse:size-11");
  });

  it("starts the phone drawer closed and keeps it out of the server render", () => {
    const readFn = shelf.slice(shelf.indexOf("function readShelfOpen"), shelf.indexOf("function subscribeShelf"));
    const desktopFn = shelf.slice(shelf.indexOf("function isDesktopShelf"), shelf.indexOf("function readShelfOpen"));
    expect(desktopFn).toContain("(min-width: 768px)");
    expect(readFn.indexOf("isDesktopShelf()")).toBeGreaterThan(-1);
    expect(readFn.indexOf("isDesktopShelf()")).toBeLessThan(readFn.indexOf("readLocalStorage"));
    expect(shelf).toContain("let drawerOpen = false;");
    expect(shelf).toContain("useIsClient()");
    expect(shelf).toContain('!isClient && "max-md:hidden"');
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
