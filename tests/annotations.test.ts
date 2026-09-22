import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";

import {
  annotationRangeCanRender,
  annotationRemapRows,
  annotationSaveRows,
  clampUtf16Start,
  contextForRange,
  hasLossyRichMarkdown,
  mergeAnnotationRecords,
  MAX_ANNOTATION_CONTEXT_CHARS,
  normalizeDocumentText,
  renderedStudyText,
  remarkStudyAnnotations,
  remapAnnotation,
  selectRenderableAnnotations,
  type AnnotationRecord,
  validateAnnotationBatch,
  validateAnnotationDraft,
} from "@/lib/annotations";

describe("annotation SQL rows", () => {
  it("maps camel-case drafts onto the snake_case columns jsonb_to_recordset reads", () => {
    expect(annotationSaveRows([{
      startOffset: 4,
      endOffset: 9,
      quote: "Cells",
      prefix: "The ",
      suffix: " are",
      color: "sun",
      note: "basic units",
    }])).toEqual([{
      start_offset: 4,
      end_offset: 9,
      quote: "Cells",
      prefix: "The ",
      suffix: " are",
      color: "sun",
      note: "basic units",
    }]);
    expect(annotationRemapRows([
      {
        mapped: true,
        id: "a",
        startOffset: 1,
        endOffset: 3,
        quote: "ab",
        prefix: "",
        suffix: "",
        contentRevision: 2,
      },
      { mapped: false, id: "b" },
    ])).toEqual([
      {
        id: "a",
        mapped: true,
        start_offset: 1,
        end_offset: 3,
        quote: "ab",
        prefix: "",
        suffix: "",
        content_revision: 2,
      },
      {
        id: "b",
        mapped: false,
        start_offset: null,
        end_offset: null,
        quote: null,
        prefix: null,
        suffix: null,
        content_revision: null,
      },
    ]);
  });
});

describe("annotation anchors", () => {
  it("normalizes line endings and Unicode before validating offsets", () => {
    const source = "Café\r\nRésumé";
    expect(normalizeDocumentText(source)).toBe("Café\nRésumé");
    const start = normalizeDocumentText(source).indexOf("Résumé");
    expect(validateAnnotationDraft(source, { startOffset: start, endOffset: start + 6, quote: "Résumé", color: "sky" })).toMatchObject({ quote: "Résumé", prefix: "Café\n" });
  });

  it("rejects a quote whose range or context no longer matches", () => {
    expect(validateAnnotationDraft("alpha beta", { startOffset: 0, endOffset: 4, quote: "beta", color: "sun" })).toBeNull();
    expect(validateAnnotationDraft("alpha beta", { startOffset: 0, endOffset: 5, quote: "alpha", prefix: "wrong", color: "sun" })).toBeNull();
  });

  it("uses a stable rendered-text model instead of Markdown punctuation", () => {
    expect(renderedStudyText("# Heading\n\n- **Important** [fact](https://example.com)")).toBe("Heading\n\nImportant fact");
    expect(renderedStudyText("| Name | Value |\n| --- | --- |\n| Café | **two** |")).toBe("Name\tValue\nCafé\ttwo");
  });

  it("rejects overlapping writes and resolves legacy overlaps deterministically", () => {
    const source = "Alpha beta gamma";
    expect(validateAnnotationBatch(source, [
      { startOffset: 0, endOffset: 5, quote: "Alpha", color: "sun" },
      { startOffset: 4, endOffset: 9, quote: "a beta", color: "sky" },
    ])).toBeNull();
    expect(selectRenderableAnnotations([
      { id: "later", startOffset: 2, endOffset: 8, archivedAt: null },
      { id: "first", startOffset: 0, endOffset: 10, archivedAt: null },
      { id: "archived", startOffset: 0, endOffset: 2, archivedAt: "now" },
    ])).toEqual([
      { id: "first", startOffset: 0, endOffset: 10, archivedAt: null },
    ]);
  });

  it("keeps inline code and math highlights renderable while rejecting partial leaves", () => {
    const source = "Use `code` and $x^2$ here";
    const codeStart = renderedStudyText(source).indexOf("code");
    const mathStart = renderedStudyText(source).indexOf("x^2");
    expect(validateAnnotationDraft(source, { startOffset: codeStart, endOffset: codeStart + 4, quote: "code", color: "mint" })).not.toBeNull();
    expect(validateAnnotationDraft(source, { startOffset: codeStart + 1, endOffset: codeStart + 3, quote: "od", color: "mint" })).toBeNull();
    expect(validateAnnotationDraft(source, { startOffset: mathStart, endOffset: mathStart + 3, quote: "x^2", color: "rose" })).not.toBeNull();
    expect(validateAnnotationDraft(source, { startOffset: mathStart + 1, endOffset: mathStart + 2, quote: "^", color: "rose" })).toBeNull();
  });

  it("renders one canonical annotation span through formatted and leaf nodes", () => {
    const source = "**Bold** and `code` plus $x^2$";
    const rendered = renderedStudyText(source);
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(
      remarkStudyAnnotations([
        { id: "bold", startOffset: 0, endOffset: 4, archivedAt: null, color: "sun" },
        { id: "code", startOffset: 9, endOffset: 13, archivedAt: null, color: "sky" },
        { id: "math", startOffset: rendered.indexOf("x^2"), endOffset: rendered.indexOf("x^2") + 3, archivedAt: null, color: "rose" },
      ] as unknown as AnnotationRecord[]),
    );
    const tree = processor.runSync(processor.parse(source)) as unknown;
    const serialized = JSON.stringify(tree);
    expect(serialized).toContain("user-annotation-sun");
    expect(serialized).toContain("user-annotation-sky");
    expect(serialized).toContain("user-annotation-rose");
  });

  it("preserves only unique quotes when content changes", () => {
    const source = "one two three";
    const range = { startOffset: 4, endOffset: 7 };
    expect(contextForRange(source, range.startOffset, range.endOffset)).toMatchObject({ prefix: "one ", suffix: " three" });
    expect(remapAnnotation({ id: "a", quote: "two" }, "zero two three", 2)).toMatchObject({ startOffset: 5, contentRevision: 2 });
    expect(remapAnnotation({ id: "a", quote: "two", prefix: "one ", suffix: " three" }, "zero two changed", 2)).toMatchObject({ startOffset: 5, contentRevision: 2 });
    expect(remapAnnotation({ id: "a", quote: "two" }, "two and two", 2)).toBeNull();
  });

  it("archives remapped quotes that land in unrenderable code or display math", () => {
    expect(remapAnnotation({ id: "a", quote: "secret" }, "intro\n\n```\nsecret\n```\n", 2)).toBeNull();
    const display = "See this\n\n$$\nx^2\n$$\n\nlater";
    expect(remapAnnotation({ id: "a", quote: "x^2" }, display, 2)).toBeNull();
    const mathStart = renderedStudyText(display).indexOf("x^2");
    expect(annotationRangeCanRender(display, mathStart, mathStart + 3)).toBe(false);
    const inline = "Use `code` here";
    const start = renderedStudyText(inline).indexOf("code");
    expect(remapAnnotation({ id: "a", quote: "code" }, inline, 3)).toMatchObject({ startOffset: start });
  });

  it("clamps UTF-16 context windows so they do not split surrogate pairs", () => {
    const emoji = "😀";
    const filler = "a".repeat(MAX_ANNOTATION_CONTEXT_CHARS - 1);
    const source = `${emoji}${filler}quote`;
    const start = source.indexOf("quote");
    expect(clampUtf16Start(source, 1)).toBe(0);
    expect(contextForRange(source, start, start + 5).prefix.startsWith(emoji)).toBe(true);
  });

  it("omits unsupported GFM footnotes from the canonical text model", () => {
    expect(renderedStudyText("Hello[^1] world.\n\n[^1]: hidden note")).toBe("Hello world.");
  });

  it("keeps extra loaded Earlier rows when a mutation returns the first page", () => {
    const firstPage = [
      { id: "active", archivedAt: null },
      { id: "earlier-1", archivedAt: "t1" },
    ] as AnnotationRecord[];
    const loaded = [
      ...firstPage,
      { id: "earlier-2", archivedAt: "t2" },
    ] as AnnotationRecord[];
    expect(mergeAnnotationRecords(loaded, firstPage).map((row) => row.id)).toEqual([
      "active",
      "earlier-1",
      "earlier-2",
    ]);
  });

  it("detects math and legacy ink for the lossless editor fallback", () => {
    expect(hasLossyRichMarkdown("$x^2$")) .toBe(true);
    expect(hasLossyRichMarkdown('<span class="ink-fact">Fact</span>')).toBe(true);
    expect(hasLossyRichMarkdown("# Plain\n\nText")).toBe(false);
  });
});
