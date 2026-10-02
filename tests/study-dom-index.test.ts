import { parseFragment } from "parse5";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "@/components/study-markdown";
import { annotationRangeCanRender, renderedStudyText, type AnnotationRecord } from "@/lib/annotations";
import {
  buildStudyDomTextIndex,
  rangeOffsetsForStudyDom,
  type StudyIndexableNode,
} from "@/lib/study-dom-text";

type Parse5Node = {
  nodeName: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Parse5Node[];
};

function wrapParse5(node: Parse5Node): StudyIndexableNode {
  if (node.nodeName === "#text") {
    return {
      nodeType: 3,
      nodeValue: node.value ?? "",
      childNodes: [],
    };
  }
  const attrs = Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name, attr.value]));
  const classNames = new Set((attrs.class ?? "").split(/\s+/).filter(Boolean));
  const children = (node.childNodes ?? [])
    .filter((child) => child.nodeName !== "#comment")
    .map(wrapParse5);
  const element: StudyIndexableNode = {
    nodeType: 1,
    nodeValue: null,
    tagName: node.nodeName.toUpperCase(),
    childNodes: children,
    classList: { contains: (name: string) => classNames.has(name) },
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    querySelector: (selector: string) => {
      const wanted = selector.toUpperCase();
      const stack = [...children];
      while (stack.length) {
        const current = stack.shift();
        if (!current) continue;
        if ((current.tagName ?? "").toUpperCase() === wanted) return current;
        stack.unshift(...Array.from(current.childNodes));
      }
      return null;
    },
  };
  return element;
}

function articleFromHtml(inner: string): StudyIndexableNode {
  const fragment = parseFragment(`<article><div class="prose-study">${inner}</div></article>`) as Parse5Node;
  const article = (fragment.childNodes ?? []).find((child) => child.nodeName === "article");
  if (!article) throw new Error("expected article root");
  return wrapParse5(article);
}

function indexed(inner: string): string {
  return buildStudyDomTextIndex(articleFromHtml(inner)).text;
}

/** Render the real study Markdown component, as Locked In and Summary do. */
function renderedArticle(source: string, annotations?: AnnotationRecord[]): StudyIndexableNode {
  const html = renderToStaticMarkup(createElement("article", null, createElement(MarkdownBody, { source, annotations })));
  const fragment = parseFragment(html) as Parse5Node;
  const article = fragment.childNodes?.[0];
  if (!article || article.nodeName !== "article") throw new Error("expected article root");
  return wrapParse5(article);
}

function findTextNode(node: StudyIndexableNode, needle: string): StudyIndexableNode | null {
  if (node.nodeType === 3) return (node.nodeValue ?? "").includes(needle) ? node : null;
  for (const child of Array.from(node.childNodes)) {
    const found = findTextNode(child, needle);
    if (found) return found;
  }
  return null;
}

const RENDERED_SAMPLES: Array<[string, string]> = [
  ["headings then paragraphs", "# Title\n\n## I. Intro\n\nFirst para.\n\nSecond para."],
  ["paragraph then tight list", "Lead in.\n\n- one\n- two\n- three"],
  ["loose list", "- one\n\n- two\n\n- three"],
  ["nested list under a tight item", "- Parent\n  - child one\n  - child two\n- Sibling"],
  ["GFM table", "| Name | Value |\n| --- | --- |\n| Café | **two** |\n| Tea | three |"],
  ["blockquote with two paragraphs", "Before.\n\n> Quoted one.\n>\n> Quoted two.\n\nAfter."],
  ["thematic break between paragraphs", "Above the rule.\n\n---\n\nBelow the rule."],
  ["citations", "Cells divide. [S1 p.1] The nucleus stores DNA.\n\nNext block [S1 p.2]."],
  ["inline and display math", "Use $x^2$ here.\n\n$$\ny = mx + b\n$$\n\nAfter math."],
  ["fenced code block", "Before code.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter code."],
  ["bold and link", "A **bold** word and a [link](https://example.com) here."],
  ["hard line break", "Before.  \nAfter."],
  ["task list", "- [ ] Task one\n- [x] Task two\n\nAfter."],
  ["hard break in a list item and a task list", "- First line  \n  second line\n- Plain\n\n- [ ] Task one\n- [x] Task two\n\nPara one.\n\nPara two."],
];

describe("study DOM text index", () => {
  it("keeps canonical separators through the MarkdownBody wrapper DIV", () => {
    const source = "First paragraph.\n\nSecond paragraph.";
    expect(indexed("<p>First paragraph.</p><p>Second paragraph.</p>")).toBe(renderedStudyText(source));
  });

  it("indexes formatted phrasing as visible text", () => {
    const source = "**Bold** and [fact](https://example.com)";
    expect(indexed("<p><strong>Bold</strong> and <a href=\"https://example.com\">fact</a></p>")).toBe(
      renderedStudyText(source),
    );
  });

  it("adds GFM table cell and row separators", () => {
    const source = "| Name | Value |\n| --- | --- |\n| Café | **two** |";
    expect(
      indexed("<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Café</td><td><strong>two</strong></td></tr></tbody></table>"),
    ).toBe(renderedStudyText(source));
  });

  it("uses KaTeX annotation text for math beside ordinary words", () => {
    const source = "Use $x^2$ here";
    expect(
      indexed("<p>Use <span class=\"katex\"><math><annotation encoding=\"application/x-tex\">x^2</annotation><mi>x</mi></math></span> here</p>"),
    ).toBe(renderedStudyText(source));
  });

  it("preserves Unicode and repeated phrases", () => {
    const source = "Café Café";
    expect(indexed("<p>Café Café</p>")).toBe(renderedStudyText(source));
    expect(indexed("<p>Café Café</p>")).toBe("Café Café");
  });

  it("rejects only unsupported ranges, not whole documents that also have ordinary text", () => {
    const source = "Ordinary text\n\n$$\nx^2\n$$\n\nlater";
    const canonical = renderedStudyText(source);
    expect(
      indexed("<p>Ordinary text</p><span class=\"katex\"><math display=\"block\"><annotation encoding=\"application/x-tex\">x^2</annotation></math></span><p>later</p>"),
    ).toBe(canonical);
    expect(annotationRangeCanRender(source, 0, 13)).toBe(true);
    const mathStart = canonical.indexOf("x^2");
    expect(annotationRangeCanRender(source, mathStart, mathStart + 3)).toBe(false);
  });

  it("does not count dropped GFM footnote markers", () => {
    const source = "Hello[^1] world.\n\n[^1]: hidden note";
    expect(indexed("<p>Hello world.</p>")).toBe(renderedStudyText(source));
  });

  it("skips citation chips and unsourced tags so offsets match the chip-free text", () => {
    const source = "Cells divide. [S1 p.2] The nucleus stores DNA. [[unsourced]] Next.";
    const plain = "Cells divide.  The nucleus stores DNA.  Next.";
    const html = [
      "<p>Cells divide. ",
      "<button type=\"button\" data-study-skip=\"\" class=\"study-cite\" aria-label=\"Open source page 2\">p.2</button>",
      " <span class=\"study-claim\" data-claim=\"unsourced\">The nucleus stores DNA.</span> ",
      "<span data-study-skip=\"\" class=\"study-unsourced\"><button type=\"button\">Not from your uploaded sources</button>",
      "<span role=\"dialog\" hidden>This sentence did not come from your uploaded sources.</span></span>",
      " Next.</p>",
    ].join("");
    expect(indexed(html)).toBe(renderedStudyText(source));
    expect(indexed(html)).toBe(renderedStudyText(plain));
  });

  describe("real MarkdownBody output", () => {
    it.each(RENDERED_SAMPLES)("matches canonical text for %s", (_label, source) => {
      expect(buildStudyDomTextIndex(renderedArticle(source)).text).toBe(renderedStudyText(source));
    });

    it("keeps the same text when a highlight is rendered", () => {
      const source = "# Title\n\nFirst para has a phrase.\n\n- one\n- two";
      const canonical = renderedStudyText(source);
      const startOffset = canonical.indexOf("phrase");
      const highlight: AnnotationRecord = {
        id: "ann-1",
        reviewerId: "rev-1",
        viewId: "view-1",
        kind: "locked_in",
        contentRevision: 1,
        startOffset,
        endOffset: startOffset + "phrase".length,
        quote: "phrase",
        prefix: "",
        suffix: "",
        color: "sun",
        note: null,
        archivedAt: null,
        archiveReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const plain = renderToStaticMarkup(createElement(MarkdownBody, { source }));
      const highlighted = renderToStaticMarkup(createElement(MarkdownBody, { source, annotations: [highlight] }));
      expect(highlighted).not.toBe(plain);
      expect(buildStudyDomTextIndex(renderedArticle(source, [highlight])).text).toBe(canonical);
    });

    it.each([
      ["a later block", "# Title\n\n## I. Intro\n\nThe mitochondria makes energy.", "mitochondria"],
      ["text after a hard line break", "Before.  \nAfter.", "After."],
      ["a paragraph after a task list", "- [ ] Task one\n- [x] Task two\n\nAfter.", "After."],
      ["a task item", "- [ ] Task one\n- [x] Task two\n\nAfter.", "Task two"],
    ])("maps a selection in %s to canonical offsets", (_label, source, word) => {
      const root = renderedArticle(source);
      const index = buildStudyDomTextIndex(root);
      const node = findTextNode(root, word);
      if (!node) throw new Error("expected text node");
      const startOffset = (node.nodeValue ?? "").indexOf(word);
      const offsets = rangeOffsetsForStudyDom(
        root,
        { startContainer: node, startOffset, endContainer: node, endOffset: startOffset + word.length },
        index,
      );
      expect(offsets).not.toBeNull();
      expect(renderedStudyText(source).slice(offsets?.startOffset, offsets?.endOffset)).toBe(word);
    });

    it("maps a point inside a dropped prefix to the start of the text", () => {
      const source = "Before.  \nAfter.";
      const root = renderedArticle(source);
      const index = buildStudyDomTextIndex(root);
      const node = findTextNode(root, "After.");
      if (!node) throw new Error("expected text node");
      const offsets = rangeOffsetsForStudyDom(
        root,
        { startContainer: node, startOffset: 0, endContainer: node, endOffset: (node.nodeValue ?? "").length },
        index,
      );
      expect(renderedStudyText(source).slice(offsets?.startOffset, offsets?.endOffset)).toBe("After.");
    });
  });
});
