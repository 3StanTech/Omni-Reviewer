import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { pacedDueCounts } from "@/lib/queries";
import { selectTodayCards } from "@/lib/pacing";
import { PackMastery } from "@/components/reviewer-list";

const root = path.resolve(__dirname, "..");
const EM_DASH = "\u2014";

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("paced due-today pack counts", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");
  const at = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  it("caps new cards at 20 a day without an exam", () => {
    expect(
      pacedDueCounts(
        { reviewDue: 3, newDue: 40, newRemaining: 50, introducedLast24h: 5 },
        { examDate: null, deletingAt: null, now },
      ),
    ).toEqual({ dueToday: 18, reviewDue: 3, newToday: 15, newRemaining: 50, introducedLast24h: 5 });
  });

  it("matches selectTodayCards on the same cards with an exam", () => {
    const cards = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, dueAt: at(-1), createdAt: at(-20), isNew: false })),
      { id: "r-later", dueAt: at(2), createdAt: at(-20), isNew: false },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, dueAt: at(-1), createdAt: at(-10 + i / 10), isNew: true })),
    ];
    const examDate = "2026-09-29";
    for (const introducedLast24h of [0, 2, 10]) {
      const expected = selectTodayCards(cards, { examDate, introducedLast24h, now }).length;
      const counted = pacedDueCounts(
        { reviewDue: 4, newDue: 30, newRemaining: 30, introducedLast24h },
        { examDate, deletingAt: null, now },
      ).dueToday;
      expect(counted).toBe(expected);
    }
  });

  it("counts 0 on a deleting reviewer", () => {
    expect(
      pacedDueCounts(
        { reviewDue: 3, newDue: 4, newRemaining: 4, introducedLast24h: 0 },
        { examDate: null, deletingAt: at(-1), now },
      ).dueToday,
    ).toBe(0);
  });
});

describe("home pack row contract", () => {
  const queries = read("lib/queries.ts");
  const page = read("app/page.tsx");
  const list = read("components/reviewer-list.tsx");

  it("aggregates due-today in the owner-scoped topic list query", () => {
    expect(queries).toContain("export async function listReviewersByTopic");
    expect(queries).toContain("dueTodayCount");
    expect(queries).toContain("eq(topics.userId, userId)");
    expect(queries).toContain("...pacedCountFields(reviewers.id, now)");
    expect(queries).toContain("c.archived_at is null");
    // NOT of the "new" predicate must never be NULL for a null-state card.
    expect(queries).toContain("(c.fsrs_state IS NOT NULL AND c.fsrs_state = 0)");
    expect(queries).toContain("if (args.deletingAt != null)");
  });

  it("passes examDate and dueTodayCount into pack rows", () => {
    expect(page).toContain("examDate: r.examDate");
    expect(page).toContain("dueTodayCount: r.dueTodayCount");
    expect(list).toContain("examDate: string | null");
    expect(list).toContain("dueTodayCount: number");
    expect(list).toContain("reviewDueCount: number");
    expect(list).toContain("newTodayCount: number");
    expect(list).toContain("Not generated yet");
    expect(list).toContain("`Generated ${stamp}`");
    expect(list).toContain("{dueSplitCopy(reviewer.reviewDueCount, reviewer.newTodayCount)}");
    expect(list).not.toContain("{reviewer.dueTodayCount} due");
    // The Review button still shows whenever anything is due.
    expect(list).toContain("{reviewer.dueTodayCount > 0 ? (\n                <Button");
    expect(list).toContain("{reviewer.examDate}");
    expect(list).toContain("Rename");
    expect(list).toContain("Delete");
  });

  it("defines Weak on the pack row's weak line for screen readers too", () => {
    const html = renderToStaticMarkup(createElement(PackMastery, { mastery: { score: 0.4, weakTitle: "Cells" } }));
    const weak = html.match(/title="Under 60% correct on 3 or more answers" aria-describedby="([^"]+)"/);
    expect(weak).not.toBeNull();
    expect(html).toContain(`id="${weak?.[1]}" hidden="">Under 60% correct on 3 or more answers</span>`);
    expect(html).toContain("Cells</span>");
    expect(renderToStaticMarkup(createElement(PackMastery, { mastery: { score: 0.9, weakTitle: null } }))).not.toContain("Under 60%");
  });

  it("does not put an em dash in home pack copy", () => {
    expect(list).not.toContain(EM_DASH);
    expect(page).not.toContain(EM_DASH);
  });
});
