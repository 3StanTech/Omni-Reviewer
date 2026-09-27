import { describe, expect, it } from "vitest";

import {
  hasPageMarkers,
  joinPages,
  pageCount,
  pageMarker,
  pageMarkerOverhead,
  pageText,
  splitPages,
  stripPageMarkers,
} from "@/lib/source-markers";

describe("source page markers", () => {
  it("joins pages with numbered markers and splits them back", () => {
    const joined = joinPages(["  First page ", "", "Third\npage"]);
    expect(joined).toBe(
      "<<<page 1>>>\n\nFirst page\n\n<<<page 2>>>\n\n\n\n<<<page 3>>>\n\nThird\npage",
    );
    expect(splitPages(joined)).toEqual([
      { page: 1, text: "First page" },
      { page: 2, text: "" },
      { page: 3, text: "Third\npage" },
    ]);
  });

  it("counts marker overhead exactly for already-trimmed pages", () => {
    const pages = ["a", "bb", "ccc"];
    const overhead = pages.reduce(
      (sum, _page, index) => sum + pageMarkerOverhead(index + 1, index === 0),
      0,
    );
    const textChars = pages.reduce((sum, page) => sum + page.length, 0);
    expect(joinPages(pages)).toHaveLength(textChars + overhead);
    expect(pageMarker(12)).toBe("<<<page 12>>>");
  });

  it("keeps leading unmarked text as page 0", () => {
    const text = `Preface\n\n${joinPages(["One", "Two"])}`;
    expect(splitPages(text)).toEqual([
      { page: 0, text: "Preface" },
      { page: 1, text: "One" },
      { page: 2, text: "Two" },
    ]);
  });

  it("treats unmarked text as a single whole-source page", () => {
    expect(splitPages("  Plain notes  ")).toEqual([{ page: 0, text: "Plain notes" }]);
    expect(pageCount("Plain notes")).toBe(0);
    expect(pageText("Plain notes", 0)).toBe("Plain notes");
  });

  it("reads one page and the page count", () => {
    const joined = joinPages(["One", "Two", "Three"]);
    expect(pageCount(joined)).toBe(3);
    expect(pageText(joined, 2)).toBe("Two");
    expect(pageText(joined, 4)).toBeNull();
  });

  it("strips marker lines for display", () => {
    expect(stripPageMarkers(joinPages(["One", "", "Three"]))).toBe("One\n\nThree");
    expect(stripPageMarkers("No markers here")).toBe("No markers here");
  });

  it("detects markers only on their own line", () => {
    expect(hasPageMarkers(null)).toBe(false);
    expect(hasPageMarkers(undefined)).toBe(false);
    expect(hasPageMarkers("")).toBe(false);
    expect(hasPageMarkers("Plain text")).toBe(false);
    expect(hasPageMarkers("inline <<<page 1>>> text")).toBe(false);
    expect(hasPageMarkers(joinPages(["One"]))).toBe(true);
    // Repeated calls must not depend on shared regex state.
    expect(hasPageMarkers(joinPages(["One"]))).toBe(true);
  });
});
