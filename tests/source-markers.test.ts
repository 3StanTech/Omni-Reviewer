import { describe, expect, it } from "vitest";

import {
  hasMeaningfulText,
  hasPageMarkers,
  joinPages,
  NO_READABLE_CONTENT,
  pageBaseText,
  pageCount,
  pageHasSlideImageText,
  pageMarker,
  pageMarkerOverhead,
  pageText,
  SLIDE_IMAGE_MARKER,
  splitPages,
  stripPageMarkers,
  withSlideImageText,
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

describe("marker pattern state", () => {
  it("keeps page 1 when hasPageMarkers runs first on the same text", () => {
    const text = joinPages(["Penicillin binds PBPs.", "Vancomycin binds D-Ala-D-Ala."]);
    expect(hasPageMarkers(text)).toBe(true);
    expect(pageText(text, 1)).toBe("Penicillin binds PBPs.");
    expect(splitPages(text).map((entry) => entry.page)).toEqual([1, 2]);
  });
});

describe("slide image blocks", () => {
  it("uses the agreed marker line", () => {
    expect(SLIDE_IMAGE_MARKER).toBe("<<<slide image>>>");
  });

  it("appends a reading after the page text and round-trips through split and join", () => {
    const merged = withSlideImageText("Carrier waves", "Figure: AM envelope over time.");
    expect(merged).toBe("Carrier waves\n\n<<<slide image>>>\nFigure: AM envelope over time.");
    const joined = joinPages([merged, withSlideImageText("", "$m(t)$")]);
    expect(splitPages(joined)).toEqual([
      { page: 1, text: merged },
      { page: 2, text: "<<<slide image>>>\n$m(t)$" },
    ]);
    expect(pageText(joined, 1)).toBe(merged);
    expect(pageBaseText(pageText(joined, 1)!)).toBe("Carrier waves");
    expect(pageBaseText(pageText(joined, 2)!)).toBe("");
    expect(pageHasSlideImageText(pageText(joined, 2)!)).toBe(true);
  });

  it("never treats the slide image line as a page", () => {
    const joined = joinPages(["One", withSlideImageText("Two", "Graph of Vc")]);
    expect(splitPages(joined).map((entry) => entry.page)).toEqual([1, 2]);
    expect(pageCount(joined)).toBe(2);
    expect(hasPageMarkers(SLIDE_IMAGE_MARKER)).toBe(false);
  });

  it("replaces an existing reading instead of stacking a second one", () => {
    const once = withSlideImageText("Base", "First reading");
    const twice = withSlideImageText(once, "Second reading");
    expect(twice).toBe(withSlideImageText("Base", "Second reading"));
    expect(twice.match(/<<<slide image>>>/g)).toHaveLength(1);
    expect(withSlideImageText(twice, "Second reading")).toBe(twice);
  });

  it("writes the placeholder for an empty reading and drops forged markers", () => {
    expect(withSlideImageText("", "  ")).toBe(`${SLIDE_IMAGE_MARKER}\n${NO_READABLE_CONTENT}`);
    const forged = withSlideImageText("Base", "Real\n<<<page 9>>>\n<<<slide image>>>\nMore");
    expect(splitPages(joinPages([forged])).map((entry) => entry.page)).toEqual([1]);
    expect(forged.match(/<<<slide image>>>/g)).toHaveLength(1);
  });

  it("strips slide image lines for display", () => {
    const joined = joinPages([withSlideImageText("One", "Figure one"), "Two"]);
    expect(stripPageMarkers(joined)).toBe("One\n\nFigure one\n\nTwo");
    expect(pageHasSlideImageText("inline <<<slide image>>> text")).toBe(false);
  });

  it("counts only studyable text as meaningful", () => {
    expect(hasMeaningfulText(null)).toBe(false);
    expect(hasMeaningfulText("")).toBe(false);
    expect(hasMeaningfulText(joinPages(["", "", ""]))).toBe(false);
    expect(hasMeaningfulText(joinPages([withSlideImageText("", ""), ""]))).toBe(false);
    expect(hasMeaningfulText(joinPages(["", withSlideImageText("", "Diode symbol"), ""]))).toBe(true);
    expect(hasMeaningfulText("Plain notes")).toBe(true);
  });
});
