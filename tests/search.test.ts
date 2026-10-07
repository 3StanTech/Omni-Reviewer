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
    const segments = cleanSnippet("<<<page 3>>>\nFirst\n\nsecond «hit».");
    expect(segments.map((segment) => segment.text).join("")).toBe("First second hit.");
  });

  it("strips Markdown noise but keeps marked words", () => {
    const text = cleanSnippet("* **«Clinical» Utility:** Drugs `bind` [the «target»](http://x.y) and snake_case stays");
    expect(text.map((s) => s.text).join("")).toBe("Clinical Utility: Drugs bind the target and snake_case stays…");
    expect(text.filter((s) => s.mark).map((s) => s.text)).toEqual(["Clinical", "target"]);
    expect(cleanSnippet("## Heading with _«emphasis»_ here.").map((s) => s.text).join("")).toBe("Heading with emphasis here.");
    expect(cleanSnippet("> Quoted «hit».").map((s) => s.text).join("")).toBe("Quoted hit.");
  });

  it("drops table pipes and separator rows", () => {
    const text = cleanSnippet("| Drug | Use |\n| --- | --- |\n| «Beta» | kills |");
    expect(text.map((s) => s.text).join("")).toBe("Drug Use Beta kills…");
    expect(text.some((s) => s.mark && s.text === "Beta")).toBe(true);
  });

  it("keeps markup as inert text", () => {
    const segments = cleanSnippet('<script>alert(1)</script> «<img src=x onerror=alert(1)>»');
    expect(segments).toEqual([
      { text: "…<script>alert(1)</script> ", mark: false },
      { text: "<img src=x onerror=alert(1)>", mark: true },
      { text: "…", mark: false },
    ]);
  });

  it("handles unbalanced and empty input", () => {
    expect(cleanSnippet("")).toEqual([]);
    expect(cleanSnippet("stray » close «open")).toEqual([
      { text: "…stray  close ", mark: false },
      { text: "open", mark: true },
      { text: "…", mark: false },
    ]);
  });

  it("drops a citation cut at the end of the fragment", () => {
    const segments = cleanSnippet("…(beta-lactam + «penicillin» + streptomycin) [S1 p.12");
    const text = segments.map((s) => s.text).join("");
    expect(text).not.toContain("[S1");
    expect(text).toBe("…(beta-lactam + penicillin + streptomycin)…");
    expect(segments.filter((s) => s.mark).map((s) => s.text)).toEqual(["penicillin"]);
    expect(cleanSnippet("Binds «30S» [[unsourced").map((s) => s.text).join("")).toBe("Binds 30S…");
  });

  it("drops a citation tail cut at the start of the fragment", () => {
    const text = cleanSnippet("p.4] word «hit» here.").map((s) => s.text).join("");
    expect(text).not.toContain("p.4]");
    expect(text).toBe("…word hit here.");
    expect(cleanSnippet("S2 p.10]] Binds «30S».").map((s) => s.text).join("")).toBe("Binds 30S.");
  });

  it("adds ellipses only where the fragment is cut", () => {
    expect(cleanSnippet("Binds the «30S» subunit.")).toEqual([
      { text: "Binds the ", mark: false },
      { text: "30S", mark: true },
      { text: " subunit.", mark: false },
    ]);
    expect(cleanSnippet("«Penicillin» binds")).toEqual([
      { text: "Penicillin", mark: true },
      { text: " binds…", mark: false },
    ]);
    expect(cleanSnippet("binds «PBP»")).toEqual([
      { text: "…binds ", mark: false },
      { text: "PBP", mark: true },
      { text: "…", mark: false },
    ]);
    expect(cleanSnippet("12 drugs: «beta-lactams» and more:").map((s) => s.text).join("")).toBe("12 drugs: beta-lactams and more:");
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
