import { describe, expect, it } from "vitest";
import {
  cleanSnippet,
  parseSearchQuery,
  searchKindLabel,
  searchResultHref,
  sectionAnchorFor,
} from "@/lib/search";

describe("parseSearchQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(parseSearchQuery("  beta   lactam \n")).toBe("beta lactam");
  });

  it("rejects too short, too long and non-string input", () => {
    expect(parseSearchQuery(" a ")).toBeNull();
    expect(parseSearchQuery("x".repeat(201))).toBeNull();
    expect(parseSearchQuery("x".repeat(200))).toBe("x".repeat(200));
    expect(parseSearchQuery(undefined)).toBeNull();
  });
});

describe("cleanSnippet", () => {
  it("splits marks and strips citations and unsourced tokens", () => {
    expect(cleanSnippet("Binds the «30S» subunit. [S1 p.14] [[unsourced]] Then more.")).toEqual([
      { text: "Binds the ", mark: false },
      { text: "30S", mark: true },
      { text: " subunit. Then more.", mark: false },
    ]);
  });

  it("removes page markers and collapses newlines", () => {
    const segments = cleanSnippet("<<<page 3>>>\nfirst\n\nsecond «hit»");
    expect(segments.map((segment) => segment.text).join("")).toBe("first second hit");
  });

  it("strips Markdown noise but keeps marked words", () => {
    const text = cleanSnippet("* **«Clinical» Utility:** Drugs `bind` [the «target»](http://x.y) and snake_case stays");
    expect(text.map((s) => s.text).join("")).toBe("Clinical Utility: Drugs bind the target and snake_case stays");
    expect(text.filter((s) => s.mark).map((s) => s.text)).toEqual(["Clinical", "target"]);
    expect(cleanSnippet("## Heading with _«emphasis»_ here").map((s) => s.text).join("")).toBe("Heading with emphasis here");
    expect(cleanSnippet("> quoted «hit»").map((s) => s.text).join("")).toBe("quoted hit");
  });

  it("drops table pipes and separator rows", () => {
    const text = cleanSnippet("| Drug | Use |\n| --- | --- |\n| «Beta» | kills |");
    expect(text.map((s) => s.text).join("")).toBe("Drug Use Beta kills");
    expect(text.some((s) => s.mark && s.text === "Beta")).toBe(true);
  });

  it("keeps markup as inert text", () => {
    const segments = cleanSnippet('<script>alert(1)</script> «<img src=x onerror=alert(1)>»');
    expect(segments).toEqual([
      { text: "<script>alert(1)</script> ", mark: false },
      { text: "<img src=x onerror=alert(1)>", mark: true },
    ]);
  });

  it("handles unbalanced and empty input", () => {
    expect(cleanSnippet("")).toEqual([]);
    expect(cleanSnippet("stray » close «open")).toEqual([
      { text: "stray  close ", mark: false },
      { text: "open", mark: true },
    ]);
  });
});

describe("sectionAnchorFor", () => {
  const markdown = ["# Intro", "", "Opening text here.", "", "## Mechanism", "", "Binds the 30S subunit.", "", "## Mechanism", "", "Second block."].join("\n");

  it("returns the nearest preceding heading id", () => {
    expect(sectionAnchorFor(markdown, markdown.indexOf("Opening"))).toBe("intro");
    expect(sectionAnchorFor(markdown, markdown.indexOf("30S"))).toBe("mechanism");
    expect(sectionAnchorFor(markdown, markdown.indexOf("Second"))).toBe("mechanism-2");
  });

  it("counts a heading line that contains the offset", () => {
    expect(sectionAnchorFor(markdown, markdown.indexOf("Mechanism") + 3)).toBe("mechanism");
  });

  it("returns null before any heading or without headings", () => {
    expect(sectionAnchorFor("Preface line\n\n# Later", 3)).toBeNull();
    expect(sectionAnchorFor("no headings at all", 5)).toBeNull();
    expect(sectionAnchorFor("", 0)).toBeNull();
  });

  it("clamps out of range offsets", () => {
    expect(sectionAnchorFor(markdown, 10_000)).toBe("mechanism-2");
    expect(sectionAnchorFor(markdown, -5)).toBe("intro");
  });
});

describe("searchResultHref and searchKindLabel", () => {
  const base = { topicId: "t1", reviewerId: "r1" };

  it("links source pages to the modal", () => {
    expect(searchResultHref({ ...base, kind: "source_page", sourceIndex: 2, page: 14 })).toBe("/topics/t1/reviewers/r1?source=2&page=14");
    expect(searchResultHref({ ...base, kind: "source_page", sourceIndex: 2, page: null })).toBe("/topics/t1/reviewers/r1?source=2");
    expect(searchResultHref({ ...base, kind: "source_page", sourceId: "abc-1", page: 14 })).toBe(
      "/topics/t1/reviewers/r1?sourceId=abc-1&page=14",
    );
    expect(searchResultHref({ ...base, kind: "source_page", sourceId: "abc-1", sourceIndex: 2, page: null })).toBe(
      "/topics/t1/reviewers/r1?sourceId=abc-1&source=2",
    );
  });

  it("links study sections with the rendered heading id", () => {
    expect(searchResultHref({ ...base, kind: "locked_in", headingId: "mechanism" })).toBe(
      "/topics/t1/reviewers/r1?mode=locked_in#user-content-mechanism",
    );
    expect(searchResultHref({ ...base, kind: "summary", headingId: null })).toBe("/topics/t1/reviewers/r1?mode=summary");
  });

  it("links cards to Carded", () => {
    expect(searchResultHref({ ...base, kind: "card" })).toBe("/topics/t1/reviewers/r1?mode=carded");
  });

  it("labels each kind", () => {
    expect(searchKindLabel({ kind: "source_page", page: 7 })).toBe("Slide 7");
    expect(searchKindLabel({ kind: "source_page", page: null })).toBe("Source");
    expect(searchKindLabel({ kind: "locked_in" })).toBe("Locked In");
    expect(searchKindLabel({ kind: "summary" })).toBe("Summary");
    expect(searchKindLabel({ kind: "card" })).toBe("Card");
  });
});
