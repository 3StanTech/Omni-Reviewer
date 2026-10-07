/** Class that lets one over-wide inline formula scroll inside the text column. */
export const WIDE_MATH_CLASS = "math-overflow";

/** True when a formula is wider than the column (1px tolerance for subpixel rounding). */
export function isWide(mathWidth: number, columnWidth: number): boolean {
  return columnWidth > 0 && mathWidth > columnWidth + 1;
}

/** Content-box width of an element (its client width without horizontal padding). */
function contentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

/**
 * Marks inline formulas wider than their text column so only those scroll. The
 * column is the formula's text block (paragraphs and list items keep a 72ch
 * measure), else the article's content box. Display math already scrolls through
 * its own rule and is skipped. Inline math never gets a blanket overflow rule: a
 * tall glyph would then show a scrollbar.
 */
export function markWideInlineMath(article: HTMLElement) {
  for (const formula of article.querySelectorAll<HTMLElement>(".katex")) {
    if (formula.closest(".katex-display")) continue;
    const math = formula.querySelector("math");
    if (math?.getAttribute("display") === "block") continue;
    const block = formula.closest<HTMLElement>("p, li, dd, blockquote");
    const column = contentWidth(block && article.contains(block) ? block : article);
    // The <math> keeps its natural width inside the scroll box, so the measure is stable either way.
    const width = (math ?? formula).getBoundingClientRect().width;
    formula.classList.toggle(WIDE_MATH_CLASS, isWide(width, column));
  }
}
