import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TodayCard } from "@/components/today-card";
import { todayHrefs } from "@/components/study-home";
import type { TodayPlan } from "@/lib/today-plan";

vi.mock("server-only", () => ({}));

const root = path.resolve(__dirname, "..");
const hrefs = todayHrefs({ p1: "t1", p2: "t2" });

function plan(overrides: Partial<TodayPlan>): TodayPlan {
  return {
    bar: { dueCards: 0, reviewCards: 0, newCards: 0, weakSections: 0, exam: null, minutes: 0 },
    doFirst: [],
    pacing: [],
    empty: false,
    ...overrides,
  };
}

function render(value: TodayPlan) {
  return renderToStaticMarkup(createElement(TodayCard, { plan: value, hrefs, onOpenPlan: () => {} }));
}

/** The Start studying anchor's href, or null when the card has none. */
function startHref(html: string): string | null {
  const match = html.match(/<a[^>]*href="([^"]+)"[^>]*>Start studying<\/a>/);
  return match ? match[1].replaceAll("&amp;", "&") : null;
}

describe("Today card", () => {
  it("starts due cards in Carded of the busiest pack", () => {
    const html = render(
      plan({
        bar: { dueCards: 12, reviewCards: 4, newCards: 8, weakSections: 1, exam: null, minutes: 5 },
        doFirst: [
          { kind: "review", dueCards: 12, packCount: 2, packId: "p1" },
          { kind: "retest", packId: "p2", sectionId: "cells", title: "Cells", score: 0.3, missed: 4 },
        ],
      }),
    );
    expect(html).toContain("Today");
    expect(html).toContain("4 to review · 8 new · ");
    expect(html).not.toContain("cards due");
    expect(startHref(html)).toBe("/topics/t1/reviewers/p1?mode=carded");
    expect(html).toContain("See the plan");
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("starts a re-test in Test Me when only weak sections remain", () => {
    const html = render(
      plan({
        bar: { dueCards: 0, reviewCards: 0, newCards: 0, weakSections: 1, exam: null, minutes: 5 },
        doFirst: [{ kind: "retest", packId: "p2", sectionId: "cells", title: "Cells", score: 0.3, missed: 4 }],
      }),
    );
    expect(startHref(html)).toBe("/topics/t2/reviewers/p2?mode=test_me");
  });

  it("starts a re-read in Locked In at the section heading", () => {
    const html = render(
      plan({
        bar: { dueCards: 0, reviewCards: 0, newCards: 0, weakSections: 1, exam: null, minutes: 5 },
        doFirst: [{ kind: "reread", packId: "p1", sectionId: "cells", title: "Cells", score: 0.3, minutes: 4 }],
      }),
    );
    expect(startHref(html)).toBe("/topics/t1/reviewers/p1?mode=locked_in#user-content-cells");
  });

  it("describes the weak segment with the Weak definition, not by hover alone", () => {
    const html = render(
      plan({
        bar: { dueCards: 0, reviewCards: 0, newCards: 0, weakSections: 3, exam: null, minutes: 20 },
        doFirst: [{ kind: "retest", packId: "p2", sectionId: "cells", title: "Cells", score: 0.3, missed: 4 }],
      }),
    );
    const weak = html.match(/<span title="Under 60% correct on 3 or more answers" aria-describedby="([^"]+)">3 weak sections<\/span>/);
    expect(weak).not.toBeNull();
    expect(html).toContain(`<span id="${weak?.[1]}" hidden="">Under 60% correct on 3 or more answers</span>`);
    expect(html).toContain("3 weak sections</span> · About 20 min");
  });

  it("offers How cards come back beside See the plan", () => {
    const html = render(plan({ empty: true }));
    expect(html).toContain('aria-label="How cards come back"');
    expect(html.indexOf("See the plan")).toBeLessThan(html.indexOf("How cards come back"));
  });

  it("shows Nothing due today and only See the plan when the plan is empty", () => {
    const html = render(plan({ empty: true }));
    expect(html).toContain("Nothing due today");
    expect(html).not.toContain("Start studying");
    expect(html).toContain("See the plan");
  });

  it("lets the summary wrap instead of truncating", () => {
    const html = render(plan({ bar: { dueCards: 3, reviewCards: 3, newCards: 0, weakSections: 0, exam: null, minutes: 5 } }));
    expect(html).not.toContain("truncate");
  });

  it("replaces the Today bar and the Practice due cards button on the desk", () => {
    const card = readFileSync(path.join(root, "components/today-card.tsx"), "utf8");
    const home = readFileSync(path.join(root, "components/study-home.tsx"), "utf8");
    expect(card).not.toContain("—");
    expect(home).toContain("<TodayCard");
    expect(home).not.toContain("Practice due cards");
    expect(home).not.toContain("components/today-b" + "ar");
  });
});
