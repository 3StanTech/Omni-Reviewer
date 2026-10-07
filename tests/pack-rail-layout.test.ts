import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SectionMasteryList } from "@/components/section-mastery-list";
import type { SectionMastery } from "@/lib/mastery";
import type { StudyHeading } from "@/lib/study-outline";

const root = path.resolve(__dirname, "..");
const EM_DASH = "—";

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("wide app shell", () => {
  // AppShell pulls in next-auth (sign out), which does not load in node tests, so this checks source.
  it("uses 90rem for the header and main only when wide", () => {
    const shell = read("components/app-shell.tsx");
    expect(shell).toContain("wide?: boolean;");
    expect(shell).toContain("wide = false,");
    expect(shell.match(/wide \? "max-w-\[90rem\]" : "max-w-5xl"/g)?.length).toBe(2);
    const header = shell.slice(shell.indexOf("<header"), shell.indexOf("</header>"));
    expect(header).toContain('wide ? "max-w-[90rem]" : "max-w-5xl"');
    const main = shell.slice(shell.indexOf("<main"), shell.indexOf("{(title || subtitle)"));
    expect(main).toContain('wide ? "max-w-[90rem]" : "max-w-5xl"');
    expect(shell).not.toMatch(/"[^"]*max-w-5xl[^"]*\s[^"]*"/);
  });

  it("is wide on the pack page and not on the desk", () => {
    const pack = read("app/topics/[topicId]/reviewers/[reviewerId]/page.tsx");
    expect(pack).toMatch(/<AppShell[\s\S]*?\n\s+wide\n\s+>/);
    const desk = read("app/page.tsx");
    expect(desk).toContain("<AppShell");
    expect(desk).not.toMatch(/\bwide\b/);
  });
});

describe("pack rail layout", () => {
  const tabs = read("components/view-tabs.tsx");

  it("wraps the strip and the study in the pack container", () => {
    const container = tabs.indexOf('className="@container/pack');
    expect(container).toBeGreaterThan(tabs.indexOf("<Tabs\n"));
    expect(container).toBeLessThan(tabs.indexOf("sticky top-14"));
  });

  it("splits into content and rail columns only while the rail is active", () => {
    expect(tabs).toContain("const railActive = useRailActive() && !focusActive;");
    expect(tabs).toContain('cn("grid gap-8", railActive && "@min-[64rem]/pack:grid-cols-[minmax(0,1fr)_17.5rem]")');
    const aside = tabs.match(/<aside[^>]*>/)?.[0] ?? "";
    expect(aside).toContain('aria-label="Study rail"');
    expect(aside).toContain('cn("print-hide hidden", railActive && "@min-[64rem]/pack:block")');
    expect(tabs).toContain('className="sticky top-[7.5rem] flex max-h-[calc(100vh-8.5rem)] flex-col gap-4 overflow-y-auto pb-4"');
  });

  it("orders the rail: mode slot, Sections on Test Me and Carded, then Pack", () => {
    const rail = tabs.slice(tabs.indexOf("<aside"), tabs.indexOf("</aside>"));
    const slot = rail.indexOf("<ModeRailSlot />");
    const sections = rail.indexOf("<SectionMasteryList headings={lockedInHeadings} sections={sectionMastery} />");
    const pack = rail.indexOf("{railPack}");
    expect(slot).toBeGreaterThan(0);
    expect(sections).toBeGreaterThan(slot);
    expect(pack).toBeGreaterThan(sections);
    expect(rail).toContain('tab === "test_me" || tab === "carded"');
    expect(tabs).toContain("useModeToolbarRailRef()");
    expect(tabs).toMatch(/<div ref=\{railRef\}/);
    expect(tabs).toContain('studyOutline(lockedInContent)');
    expect(tabs).toContain("railPack?: ReactNode;");
  });

  it("keeps the study end sentinel in the content column, right after the mode content", () => {
    const after = tabs.slice(tabs.indexOf("</TabsContent>"));
    const sentinel = after.indexOf("<div data-study-end aria-hidden");
    expect(sentinel).toBeGreaterThan(0);
    expect(sentinel).toBeLessThan(after.indexOf("<aside"));
    expect(after.slice(0, sentinel)).not.toMatch(/<(div|section|p)\b/);
  });

  it("leaves the strip free of filters and transforms", () => {
    const strip = tabs.match(/className="print-hide sticky top-14[^"]*"/)?.[0] ?? "";
    expect(strip).not.toBe("");
    for (const trap of ["backdrop-", "blur", "transform", "translate", "filter", "will-change"]) {
      expect(strip, trap).not.toContain(trap);
    }
  });
});

describe("section mastery list", () => {
  const headings: StudyHeading[] = [
    { id: "cells", text: "Cells", level: 1 },
    { id: "membranes", text: "Membranes", level: 2 },
    { id: "pumps", text: "Pumps", level: 3 },
    { id: "energy", text: "Energy", level: 2 },
  ];
  const sections: SectionMastery[] = [
    { id: "cells", title: "Cells", score: 0.8, items: 6, weak: false },
    { id: "membranes", title: "Membranes", score: 0.3, items: 4, weak: true },
    { id: "energy", title: "Energy", score: null, items: 1, weak: false },
  ];

  it("lists the top two heading levels with mastery, weak marked, and no links", () => {
    const html = renderToStaticMarkup(createElement(SectionMasteryList, { headings, sections }));
    expect(html).toContain("Sections");
    expect(html).toContain("Cells");
    expect(html).toContain("Membranes");
    expect(html).toContain("Energy");
    expect(html).not.toContain("Pumps");
    expect(html).not.toContain("<a ");
    expect(html.match(/aria-label="Weak section"/g)?.length).toBe(1);
    expect(html).toContain('aria-label="Mastery 80 percent"');
    expect(html).toContain("Not enough answers yet");
  });

  it("shows no score note when mastery is missing", () => {
    const html = renderToStaticMarkup(createElement(SectionMasteryList, { headings, sections: null }));
    expect(html.match(/Not enough answers yet/g)?.length).toBe(3);
    expect(html).not.toContain("Weak section");
  });

  it("renders nothing without headings", () => {
    expect(renderToStaticMarkup(createElement(SectionMasteryList, { headings: [], sections }))).toBe("");
    expect(renderToStaticMarkup(createElement(SectionMasteryList, { headings: [{ id: "deep", text: "Deep", level: 3 }], sections }))).toBe("");
  });
});

describe("rail pack section", () => {
  const workspace = read("components/reviewer-workspace.tsx");

  it("repeats Sources and Exam date as buttons opening the same dialogs, and passes it to the tabs", () => {
    const pack = workspace.slice(workspace.indexOf("const railPack = hasViews ? ("), workspace.indexOf(") : null;", workspace.indexOf("const railPack")));
    expect(pack).toContain(">\n        Pack\n");
    expect(pack).toContain("onClick={() => setSourcesOpen(true)}");
    expect(pack).toContain("{sourcesLabel}");
    expect(pack).toContain("{unreadableHint ?");
    expect(pack).toContain("onClick={() => setExamDateOpen(true)}");
    expect(pack).toContain("{examDateLabel}");
    expect(pack.match(/variant="ghost"/g)?.length).toBe(2);
    expect(workspace).toContain("railPack={railPack}");
    // More keeps the same items.
    expect(workspace).toContain("label: sourcesLabel");
    expect(workspace).toContain("label: examDateLabel");
  });
});

describe("copy", () => {
  it("has no em dashes in the layout files", () => {
    for (const file of [
      "components/app-shell.tsx",
      "components/view-tabs.tsx",
      "components/section-mastery-list.tsx",
      "components/reviewer-workspace.tsx",
    ]) {
      expect(read(file), file).not.toContain(EM_DASH);
    }
  });
});
