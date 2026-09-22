import { parseFragment } from "parse5";
import { describe, expect, it } from "vitest";

import { annotationRangeCanRender, renderedStudyText } from "@/lib/annotations";
import {
  buildStudyDomTextIndex,
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
});
