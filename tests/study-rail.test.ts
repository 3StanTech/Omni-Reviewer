import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudyRailBody } from "@/components/study-rail";
import { ContentsList, NotesList, SectionMasteryProvider } from "@/components/study-side-panel";
import type { AnnotationRecord } from "@/lib/annotations";
import type { SectionMastery } from "@/lib/mastery";
import type { StudyHeading } from "@/lib/study-outline";
import { isWide, markWideInlineMath, WIDE_MATH_CLASS } from "@/lib/wide-math";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const headings: StudyHeading[] = [
  { id: "cells", text: "Cells", level: 2 },
  { id: "membranes", text: "Membranes", level: 3 },
  { id: "genetics", text: "Genetics", level: 2 },
];

const annotation = (id: string, archived = false): AnnotationRecord =>
  ({ id, quote: `Quote ${id}`, note: null, color: "sun", archivedAt: archived ? "2026-10-01T00:00:00.000Z" : null }) as unknown as AnnotationRecord;

describe("study rail", () => {
  it("renders Contents with progress, Top and End around the list, then Notes with a count", () => {
    const sections: SectionMastery[] = [{ id: "cells", title: "Cells", score: 0.5, items: 4, weak: true }];
    const html = renderToStaticMarkup(
      createElement(
        SectionMasteryProvider,
        { sections } as Parameters<typeof SectionMasteryProvider>[0],
        createElement(StudyRailBody, { headings, annotations: [annotation("a"), annotation("b"), annotation("old", true)], currentId: "membranes", progress: 42 }),
      ),
    );
    expect(html).toContain('aria-label="Read 42 percent"');
    expect(html).toContain("42%");
    const top = html.indexOf(">Top</button>");
    const list = html.indexOf('aria-label="Document contents"');
    const end = html.indexOf(">End</button>");
    expect(top).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(top);
    expect(end).toBeGreaterThan(list);
    expect(html).toContain('aria-label="Mastery 50 percent"');
    // Archived annotations do not count; saved Ask answers add nothing outside a pack.
    expect(html).toMatch(/<summary[^>]*>[\s\S]*Notes \(2\)<\/summary>/);
    expect(html).toContain("<details");
  });

  it("marks only the current section", () => {
    const html = renderToStaticMarkup(createElement(ContentsList, { headings, sections: null, currentId: "membranes" }));
    expect(html.match(/aria-current="location"/g)).toHaveLength(1);
    const items = html.split("<li").slice(1);
    expect(items[1]).toContain('aria-current="location"');
    expect(items[1]).toContain("border-primary");
    expect(items[0]).not.toContain("border-primary");
    expect(items[1]).toContain('href="#user-content-membranes"');
  });

  it("keeps the strip Contents unmarked without a current section", () => {
    const html = renderToStaticMarkup(createElement(ContentsList, { headings, sections: null }));
    expect(html).not.toContain("aria-current");
  });

  it("shares the Notes body with the strip popover", () => {
    const empty = renderToStaticMarkup(createElement(NotesList, { annotations: [] }));
    expect(empty).toContain("No highlights or notes yet. Select text in the document to highlight or add a note.");
    const filled = renderToStaticMarkup(createElement(NotesList, { annotations: [annotation("a"), annotation("old", true)] }));
    expect(filled).toContain("Quote a");
    expect(filled).not.toContain("Quote old");
    expect(read("components/study-side-panel.tsx")).toContain('{open === "notes" ? <NotesList annotations={annotations} /> : null}');
  });

  it("tracks the section at 30% of the viewport and the study end sentinel", () => {
    const rail = read("components/study-rail.tsx");
    expect(rail).toContain("CURRENT_HEADING_LINE = 0.3");
    expect(rail).toContain("currentHeadingIndex(tops, viewport * CURRENT_HEADING_LINE)");
    expect(rail).toContain('document.querySelector("[data-study-end]")');
    expect(rail).toContain("STUDY_HEADING_CLOBBER_PREFIX + heading.id");
    expect(rail).toContain('window.addEventListener("scroll", schedule, { passive: true })');
    expect(rail).toContain("window.requestAnimationFrame(measure)");
    expect(rail).toContain("observer?.disconnect()");
    expect(rail).toContain("onClick={scrollToTop}");
    expect(rail).toContain("onClick={scrollToStudyEnd}");
    expect(rail).toContain("heading.level <= 3");
  });
});

describe("study document and the rail", () => {
  const document = read("components/study-document.tsx");

  it("portals the rail while reading and hides the strip duplicates only while the rail is active", () => {
    expect(document).toContain("<ModeRail>");
    expect(document).toContain("<StudyRail markdown={view.content} annotations={annotations} articleRef={articleRef} />");
    expect(document).toContain("const railActive = useRailActive();");
    expect(document).toContain('className={railActive ? "@min-[64rem]/pack:hidden" : undefined}');
    const panel = read("components/study-side-panel.tsx");
    expect(panel).toContain('<div className={cn("flex items-center gap-1", className)}>');
  });

  it("measures wide inline math after render and on resize", () => {
    expect(document).toContain("markWideInlineMath(article)");
    expect(document).toContain("new ResizeObserver(mark)");
    expect(document).toContain("observer?.disconnect()");
  });
});

describe("wide inline math", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is wide only past the column plus a pixel of rounding", () => {
    expect(isWide(600, 600)).toBe(false);
    expect(isWide(601, 600)).toBe(false);
    expect(isWide(602, 600)).toBe(true);
    expect(isWide(1062, 647)).toBe(true);
    expect(isWide(100, 0)).toBe(false);
  });

  it("marks wide inline formulas, unmarks narrow ones and skips display math", () => {
    vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "32px", paddingRight: "32px" }));
    const formula = (width: number, { displayParent = false, displayMath = false, marked = false } = {}) => {
      const classes = new Set(marked ? [WIDE_MATH_CLASS] : []);
      const math = { getAttribute: (name: string) => (name === "display" && displayMath ? "block" : null), getBoundingClientRect: () => ({ width }) };
      return {
        classes,
        closest: (selector: string) => (selector === ".katex-display" && displayParent ? {} : null),
        querySelector: () => math,
        getBoundingClientRect: () => ({ width }),
        classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
      };
    };
    const wide = formula(1062);
    const narrow = formula(200, { marked: true });
    const displayed = formula(1062, { displayParent: true });
    const blockMath = formula(1062, { displayMath: true });
    const article = { clientWidth: 711, querySelectorAll: () => [wide, narrow, displayed, blockMath] };
    markWideInlineMath(article as unknown as HTMLElement);
    expect(wide.classes.has(WIDE_MATH_CLASS)).toBe(true);
    expect(narrow.classes.has(WIDE_MATH_CLASS)).toBe(false);
    expect(displayed.classes.has(WIDE_MATH_CLASS)).toBe(false);
    expect(blockMath.classes.has(WIDE_MATH_CLASS)).toBe(false);
  });

  it("scrolls only measured formulas on screen and resets them in print", () => {
    const css = read("app/globals.css");
    const rule = css.match(/\.prose-study \.katex\.math-overflow\s*\{([^}]*)\}/);
    expect(rule?.[1]).toContain("display: inline-block;");
    expect(rule?.[1]).toContain("max-width: 100%;");
    expect(rule?.[1]).toContain("overflow-x: auto;");
    expect(rule?.[1]).toContain("overflow-y: hidden;");
    const print = css.slice(css.indexOf("/* Phase 4: study packet print */"));
    expect(print).toMatch(/\.prose-study \.katex\.math-overflow\s*\{[^}]*display: inline;[^}]*overflow: visible;[^}]*max-width: none;/);
    // No blanket overflow on inline math.
    expect(css).not.toMatch(/\.prose-study (?:math|\.katex)\s*\{[^}]*overflow/);
    expect(read("lib/wide-math.ts")).toContain('formula.closest(".katex-display")');
  });

  it("lands Contents jumps below the sticky header and strip on screen only", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/@media screen \{\s*\.prose-study :is\(h1, h2, h3, h4, h5, h6\) \{\s*scroll-margin-top: 8rem;/);
    expect(css).toMatch(/@media screen and \(max-width: 640px\) \{\s*\.prose-study :is\(h1, h2, h3, h4, h5, h6\) \{\s*scroll-margin-top: 11rem;/);
    const print = css.slice(css.indexOf("/* Phase 4: study packet print */"));
    expect(print).not.toContain("scroll-margin-top");
  });
});
