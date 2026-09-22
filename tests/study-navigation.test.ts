import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it, vi } from "vitest";

vi.mock("katex/dist/katex.min.css", () => ({}));

import { remarkDropStudyFootnotes } from "@/lib/annotations";
import { MarkdownBody, studySanitizeSchema } from "@/components/study-markdown";
import { parseReadingPosition, readingPositionKey } from "@/lib/reading-position";
import { outlineHeadingHref, remarkStudyHeadingIds, studyOutline } from "@/lib/study-outline";

describe("study navigation contracts", () => {
  it("creates stable duplicate-safe outline ids", () => {
    expect(studyOutline("# First\n\n## First\n\n# First")).toEqual([
      { id: "first", text: "First", level: 1 },
      { id: "first-2", text: "First", level: 2 },
      { id: "first-3", text: "First", level: 1 },
    ]);
  });

  it("uses rendered heading text when legacy ink markup is present", () => {
    expect(studyOutline('# <span class="ink-fact">Legacy heading</span>')).toEqual([
      { id: "legacy-heading", text: "Legacy heading", level: 1 },
    ]);
  });

  it("stamps the same ids onto rendered headings, including duplicates and emphasis", () => {
    const sources = [
      "# Cell Biology\n\n## Organelles\n",
      "# First\n\n## First\n\n# First",
      "## *Organelles*\n\n# Café résumé",
      '# <span class="ink-fact">Legacy heading</span>',
    ];
    for (const source of sources) {
      const expected = studyOutline(source).map((heading) => heading.id);
      let invocations = 0;
      const heading = (level: number) =>
        function RenderedHeading({ id, children }: { id?: string; children?: ReactNode }) {
          invocations += 1;
          return createElement(`h${level}`, { id }, children);
        };
      const html = renderToStaticMarkup(createElement(
        ReactMarkdown,
        {
          remarkPlugins: [
            remarkGfm,
            remarkDropStudyFootnotes,
            [remarkMath, { singleDollarTextMath: true }],
            remarkStudyHeadingIds,
          ],
          components: {
            h1: heading(1),
            h2: heading(2),
            h3: heading(3),
            h4: heading(4),
            h5: heading(5),
            h6: heading(6),
          },
        },
        source,
      ));
      const ids = [...html.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
      expect(ids).toEqual(expected);
      expect(invocations).toBe(expected.length);
    }
    const reader = readFileSync(path.join(path.resolve(__dirname, ".."), "components/study-markdown.tsx"), "utf8");
    expect(reader).toContain("remarkStudyHeadingIds");
    expect(reader).toContain("STUDY_HEADING_ID_PATTERN");
    expect(reader).not.toContain("headingIndex");
  });

  it("matches sanitized heading ids with Contents hrefs", () => {
    expect(studySanitizeSchema.clobber).toContain("id");
    expect(studySanitizeSchema.clobberPrefix).toBe("user-content-");
    const sources = [
      "# Cell Biology\n\n## Organelles\n",
      "# First\n\n## First\n\n# First",
      "## *Organelles*\n\n# Café résumé",
      '# <span class="ink-fact">Legacy heading</span>',
    ];
    for (const source of sources) {
      const html = renderToStaticMarkup(createElement(MarkdownBody, { source }));
      const renderedIds = [...html.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
      const hrefs = studyOutline(source).map((heading) => outlineHeadingHref(heading.id));
      expect(renderedIds.map((id) => `#${id}`)).toEqual(hrefs);
      expect(hrefs.every((href) => href.startsWith("#user-content-"))).toBe(true);
    }
    const panel = readFileSync(path.join(path.resolve(__dirname, ".."), "components/study-side-panel.tsx"), "utf8");
    expect(panel).toContain("outlineHeadingHref(heading.id)");
    expect(panel).not.toContain("href={`#${heading.id}`}");
  });

  it("namespaces reading position by owner, reviewer, mode and content revision", () => {
    expect(readingPositionKey("u", "r", "summary", 3)).toContain("u:r:summary:3");
    expect(parseReadingPosition({ headingId: "section", offset: 0.5 })).toEqual({ headingId: "section", offset: 0.5 });
    expect(parseReadingPosition({ headingId: "section", offset: 2 })).toBeNull();
  });
});
