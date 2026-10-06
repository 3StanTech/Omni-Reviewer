import { readFileSync } from "node:fs";
import path from "node:path";

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

  it("never makes inline math a scroll box", () => {
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    // overflow on inline <math> turns on overflow-y too, and tall glyphs then show a scrollbar.
    expect(css).not.toMatch(/\.prose-study math\s*\{[^}]*overflow/);
    expect(css).toMatch(/\.prose-study math\[display="block"\]\s*\{[^}]*overflow-x: auto/);
  });
});
