import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { countDueTodayCards } from "@/lib/queries";

const root = path.resolve(__dirname, "..");
const EM_DASH = "\u2014";

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("due-today pack counts", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");

  it("counts durable cards due at or before now", () => {
    expect(
      countDueTodayCards(
        [
          { dueAt: new Date("2026-09-19T12:00:00.000Z"), archivedAt: null },
          { dueAt: new Date("2026-09-18T23:59:59.000Z"), archivedAt: null },
          { dueAt: new Date("2026-09-19T12:00:01.000Z"), archivedAt: null },
        ],
        { now, reviewerDeletingAt: null },
      ),
    ).toBe(2);
  });

  it("skips archived cards and cards on a deleting reviewer", () => {
    const cards = [
      { dueAt: new Date("2026-09-01T00:00:00.000Z"), archivedAt: null },
      {
        dueAt: new Date("2026-09-01T00:00:00.000Z"),
        archivedAt: new Date("2026-09-18T00:00:00.000Z"),
      },
    ];
    expect(countDueTodayCards(cards, { now, reviewerDeletingAt: null })).toBe(1);
    expect(
      countDueTodayCards(cards, {
        now,
        reviewerDeletingAt: new Date("2026-09-19T00:00:00.000Z"),
      }),
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
    expect(queries).toContain("cards.due_at <= now()");
    expect(queries).toContain("cards.archived_at is null");
    expect(queries).toContain("when ${reviewers.deletingAt} is not null then 0");
  });

  it("passes examDate and dueTodayCount into pack rows", () => {
    expect(page).toContain("examDate: r.examDate");
    expect(page).toContain("dueTodayCount: r.dueTodayCount");
    expect(list).toContain("examDate: string | null");
    expect(list).toContain("dueTodayCount: number");
    expect(list).toContain("Not generated yet");
    expect(list).toContain("`Generated ${stamp}`");
    expect(list).toContain("{reviewer.dueTodayCount} due");
    expect(list).toContain("{reviewer.examDate}");
    expect(list).toContain("Rename");
    expect(list).toContain("Delete");
  });

  it("does not put an em dash in home pack copy", () => {
    expect(list).not.toContain(EM_DASH);
    expect(page).not.toContain(EM_DASH);
  });
});
