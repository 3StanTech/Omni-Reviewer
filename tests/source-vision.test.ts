import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MAX_EXTRACTED_TEXT_CHARS } from "@/lib/ingest";
import { PublicError } from "@/lib/public-errors";
import {
  joinPages,
  NO_READABLE_CONTENT,
  pageText,
  SLIDE_IMAGE_MARKER,
  splitPages,
  withSlideImageText,
} from "@/lib/source-markers";
import {
  LOW_TEXT_PAGE_CHARS,
  MAX_VISION_BATCH_BYTES,
  MAX_VISION_BATCH_PAGES,
  MAX_VISION_IMAGE_BYTES,
  MAX_VISION_PAGE_CHARS,
  mergeVisionPages,
  parseVisionBatch,
  pendingVisionPages,
  VISION_PAGES_INSTRUCTION,
  visionPageSummary,
} from "@/lib/source-vision";

describe("slide vision caps", () => {
  it("keeps the agreed batch contract", () => {
    expect(LOW_TEXT_PAGE_CHARS).toBe(200);
    expect(MAX_VISION_BATCH_PAGES).toBe(8);
    expect(MAX_VISION_IMAGE_BYTES).toBe(800 * 1024);
    expect(MAX_VISION_BATCH_BYTES).toBe(4 * 1024 * 1024);
  });

  it("asks for page-marked readings, LaTeX and handwriting, without invented facts", () => {
    expect(VISION_PAGES_INSTRUCTION).toContain("<<<page N>>>");
    expect(VISION_PAGES_INSTRUCTION).toContain("LaTeX");
    expect(VISION_PAGES_INSTRUCTION).toContain("Handwritten note:");
    expect(VISION_PAGES_INSTRUCTION).toContain(NO_READABLE_CONTENT);
    expect(VISION_PAGES_INSTRUCTION).toMatch(/Never add facts/);
    expect(VISION_PAGES_INSTRUCTION).not.toContain("—");
  });
});

describe("pendingVisionPages", () => {
  it("selects pages under the threshold, at the edge", () => {
    const text = joinPages(["x".repeat(199), "y".repeat(200), "", "z".repeat(1_000)]);
    expect(pendingVisionPages(text)).toEqual([1, 3]);
  });

  it("skips pages that were already read, even as empty", () => {
    const text = joinPages([
      withSlideImageText("", "Figure"),
      withSlideImageText("short", ""),
      "short",
    ]);
    expect(pendingVisionPages(text)).toEqual([3]);
    expect(visionPageSummary(text)).toEqual({ pending: [3], pageTotal: 3, readCount: 2 });
  });

  it("measures only the base text of a page", () => {
    const longReading = withSlideImageText("tiny", "r".repeat(500));
    // Already read, so the long reading never makes it pending again.
    expect(pendingVisionPages(joinPages([longReading]))).toEqual([]);
  });

  it("has nothing pending for unmarked text or a leading page 0", () => {
    expect(pendingVisionPages("Short pasted notes")).toEqual([]);
    expect(pendingVisionPages(`Preface\n\n${joinPages(["", "a".repeat(300)])}`)).toEqual([1]);
    expect(visionPageSummary("Short pasted notes")).toEqual({ pending: [], pageTotal: 0, readCount: 0 });
  });
});

describe("parseVisionBatch", () => {
  it("keeps requested pages in any order and drops preamble and extra pages", () => {
    const output = [
      "Here are the slides.",
      "<<<page 5>>>",
      "Five",
      "<<<page 3>>>",
      "Three",
      "<<<page 9>>>",
      "Not requested",
    ].join("\n");
    const readings = parseVisionBatch(output, [3, 4, 5]);
    expect([...readings.entries()]).toEqual([[5, "Five"], [3, "Three"]]);
    expect(readings.has(4)).toBe(false);
  });

  it("keeps the first non-empty reading of a duplicated page", () => {
    const output = "<<<page 2>>>\n\n<<<page 2>>>\nFirst\n<<<page 2>>>\nSecond";
    expect(parseVisionBatch(output, [2]).get(2)).toBe("First");
  });

  it("treats an empty reading as missing so it can be re-sent", () => {
    expect(parseVisionBatch("<<<page 1>>>\n\n<<<page 2>>>\nTwo", [1, 2]).has(1)).toBe(false);
  });

  it("accepts page lines that a model bolded or padded", () => {
    const readings = parseVisionBatch("**<<<page 1>>>**\nOne\n  <<< page 2 >>>  \nTwo", [1, 2]);
    expect(readings.get(1)).toBe("One");
    expect(readings.get(2)).toBe("Two");
  });

  it("reads slide label headings that the model echoes instead of page lines", () => {
    const output = [
      "Here are the transcribed lecture slides from the images you provided.",
      "",
      "### Slide 15:",
      "Double sideband carrier",
      "",
      "### Slide 25: Example 5",
      "Find the modulation index.",
      "",
      "<<<page 9>>>",
      "**Slide 9:**",
      "Envelope detector circuit",
      "",
      "### <<<page 1>>>",
      "Title slide",
    ].join("\n");
    const readings = parseVisionBatch(output, [1, 9, 15, 25]);
    expect(readings.get(15)).toBe("Double sideband carrier");
    expect(readings.get(25)).toBe("Example 5\nFind the modulation index.");
    expect(readings.get(9)).toBe("Envelope detector circuit");
    expect(readings.get(1)).toBe("Title slide");
    expect([...readings.values()].join("\n")).not.toContain("Here are the transcribed");
  });

  it("keeps slide mentions inside prose and figure headings as text", () => {
    const output = [
      "<<<page 11>>>",
      "#### Figure 11 Description (Slide 6):",
      "Slide 6 shows the same carrier at a higher index.",
      "Slide 3: a plain sentence that starts like a label.",
    ].join("\n");
    const readings = parseVisionBatch(output, [3, 6, 11]);
    expect([...readings.keys()]).toEqual([11]);
    expect(readings.get(11)).toBe(output.split("\n").slice(1).join("\n"));
  });

  it("does not drop a label for a different page after a marker", () => {
    const readings = parseVisionBatch("<<<page 2>>>\n**Slide 3:**\nThree", [2, 3]);
    expect(readings.has(2)).toBe(false);
    expect(readings.get(3)).toBe("Three");
  });

  it("caps each reading", () => {
    const readings = parseVisionBatch(`<<<page 1>>>\n${"a".repeat(MAX_VISION_PAGE_CHARS + 50)}`, [1]);
    expect(readings.get(1)).toHaveLength(MAX_VISION_PAGE_CHARS);
  });

  it("returns nothing for output without markers", () => {
    expect(parseVisionBatch("I cannot see any slides.", [1]).size).toBe(0);
  });
});

describe("mergeVisionPages", () => {
  it("preserves untouched pages byte for byte and appends readings", () => {
    const original = joinPages([
      "Page one keeps   its  spacing\nand lines.",
      "",
      "Page three",
      "",
    ]).trim();
    const merged = mergeVisionPages(original, new Map([[2, "Graph of the envelope"], [4, ""]]));
    const before = splitPages(original);
    const after = splitPages(merged);
    expect(after.map((entry) => entry.page)).toEqual([1, 2, 3, 4]);
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(pageText(merged, 2)).toBe(`${SLIDE_IMAGE_MARKER}\nGraph of the envelope`);
    expect(pageText(merged, 4)).toBe(`${SLIDE_IMAGE_MARKER}\n${NO_READABLE_CONTENT}`);
  });

  it("returns the same text when there is nothing to merge", () => {
    const original = joinPages(["One", "", "Three"]);
    expect(mergeVisionPages(original, new Map())).toBe(original);
  });

  it("keeps a leading page 0 in front", () => {
    const original = `Preface\n\n${joinPages(["", "Two"])}`;
    const merged = mergeVisionPages(original, new Map([[1, "Slide one"]]));
    expect(splitPages(merged)[0]).toEqual({ page: 0, text: "Preface" });
    expect(pageText(merged, 1)).toBe(`${SLIDE_IMAGE_MARKER}\nSlide one`);
  });

  it("refuses a merge beyond the stored text limit with a public error", () => {
    const original = joinPages(["x".repeat(MAX_EXTRACTED_TEXT_CHARS - 100), ""]);
    expect(() => mergeVisionPages(original, new Map([[2, "y".repeat(500)]])))
      .toThrow(PublicError);
  });
});
