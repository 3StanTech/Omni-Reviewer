import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/search-queries", () => ({
  searchPacks: vi.fn(async () => []),
  loadStudyMarkdownForHits: vi.fn(async () => new Map()),
}));

import { auth } from "@/auth";
import { searchResultHref, sectionAnchorFor } from "@/lib/search";
import { outlineHeadingHref } from "@/lib/study-outline";
import { loadStudyMarkdownForHits, searchPacks } from "@/lib/search-queries";
import { GET } from "@/app/api/search/route";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const search = (q?: string) =>
  GET(new Request(`https://omni-reviewer.example/api/search${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`));

const lockedIn = "# Pharmacology\n\nIntro text.\n\n## Beta blockers\n\nPropranolol blocks beta receptors.";

beforeEach(() => {
  mock(auth).mockResolvedValue({ user: { id: "user-1" } });
  mock(searchPacks).mockResolvedValue([]);
  mock(loadStudyMarkdownForHits).mockResolvedValue(new Map());
});

describe("GET /api/search", () => {
  it("requires a session", async () => {
    mock(auth).mockResolvedValueOnce(null);
    expect((await search("beta")).status).toBe(401);
    expect(mock(searchPacks)).not.toHaveBeenCalled();
  });

  it("returns no results for a missing, short or long query without searching", async () => {
    for (const q of [undefined, "", " b ", "x".repeat(201)]) {
      const response = await search(q);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ results: [] });
    }
    expect(mock(searchPacks)).not.toHaveBeenCalled();
  });

  it("searches only the signed-in user's packs with the cleaned query", async () => {
    await search("  beta   blockers ");
    expect(mock(searchPacks)).toHaveBeenCalledWith("user-1", "beta blockers");
    expect(mock(loadStudyMarkdownForHits)).toHaveBeenCalledWith("user-1", []);
  });

  it("maps hits to links, kind labels and marked snippets", async () => {
    const hits = [
      {
        kind: "source_page", topicId: "t1", reviewerId: "r1", packName: "Pharm", sourceId: "s1",
        sourceIndex: 2, page: 7, snippet: "<<<page 7>>>\n«Propranolol» blocks beta [S2 p.7]", rank: 0.9,
      },
      {
        kind: "locked_in", topicId: "t1", reviewerId: "r1", packName: "Pharm",
        matchOffset: lockedIn.indexOf("Propranolol"), snippet: "«Propranolol» blocks", rank: 0.8,
      },
      { kind: "card", topicId: "t2", reviewerId: "r2", packName: "Cardio", snippet: "«beta» card", rank: 0.5 },
    ];
    mock(searchPacks).mockResolvedValueOnce(hits);
    mock(loadStudyMarkdownForHits).mockResolvedValueOnce(new Map([["r1:locked_in", lockedIn]]));

    const response = await search("propranolol");
    expect(response.status).toBe(200);
    const { results } = await response.json();
    const heading = sectionAnchorFor(lockedIn, lockedIn.indexOf("Propranolol"));
    expect(heading).toBeTruthy();

    expect(results).toHaveLength(3);
    expect(new Set(results.map((result: { key: string }) => result.key)).size).toBe(3);
    expect(results[0]).toMatchObject({
      packName: "Pharm",
      kindLabel: "Slide 7",
      href: searchResultHref({ kind: "source_page", topicId: "t1", reviewerId: "r1", sourceId: "s1", sourceIndex: 2, page: 7 }),
      snippet: [{ text: "Propranolol", mark: true }, { text: " blocks beta", mark: false }],
    });
    expect(results[0].href).toContain("sourceId=s1");
    expect(results[0].href).toContain("page=7");
    expect(results[1]).toMatchObject({ kindLabel: "Locked In" });
    expect(results[1].href).toBe(`/topics/t1/reviewers/r1?mode=locked_in${outlineHeadingHref(heading!)}`);
    expect(results[1].href).toContain("beta-blockers");
    expect(results[2]).toMatchObject({ kindLabel: "Card", href: "/topics/t2/reviewers/r2?mode=carded" });
  });
});
