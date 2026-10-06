import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "@/components/study-markdown";

describe("math in study Markdown", () => {
  it("keeps the TeX annotation inside <semantics> so browsers do not draw it", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, { source: "| Disc | Resistant |\n| --- | --- |\n| $10\\ \\mu\\text{g}$ | $\\le 13$ |" }),
    );
    const formulas = html.match(/<math[\s\S]*?<\/math>/g) ?? [];
    expect(formulas).toHaveLength(2);
    for (const formula of formulas) {
      expect(formula).toMatch(/^<math[^>]*><semantics><mrow>[\s\S]*<\/mrow><annotation encoding="application\/x-tex">[\s\S]*<\/annotation><\/semantics><\/math>$/);
    }
  });
});
