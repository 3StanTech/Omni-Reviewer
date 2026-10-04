/**
 * LaTeX as plain words, for lexical matching only. Claims and source pages go
 * through the same rewrite, so `$P_t = P_c \left(1 + \frac{m^2}{2}\right)$`
 * and `50\text{ W}` compare as their symbols, numbers and units. Markup
 * command names ("text", "frac", "left") never survive as words.
 */

const GREEK = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa",
  "lambda", "mu", "nu", "xi", "pi", "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi",
  "chi", "psi", "omega",
]);

/** Named functions that read as words in prose ("sin", "log"). */
const FUNCTIONS = new Set(["sin", "cos", "tan", "sec", "csc", "cot", "sinh", "cosh", "tanh", "log", "ln", "exp", "max", "min", "lim"]);

/** Commands whose one braced argument is plain text to keep. */
const TEXT_WRAPPER = /\\(?:text|textrm|textbf|textit|mathrm|mathbf|mathit|mathsf|operatorname)\s*\{([^{}]*)\}/g;

/** `$$...$$` or `$...$` math, the same spans the claim extractor treats as inline math. */
const MATH_SPAN = /\$\$[^$]*\$\$|\$[^$\s][^$\n]*\$/g;

/** A text argument to keep as is, or a lone letter: a variable name such as the `E` and `c` of `E_c`. */
const TEXT_OR_LONE_LETTER = new RegExp(String.raw`(${TEXT_WRAPPER.source})|(?<![\p{L}\p{N}\\])\p{L}(?![\p{L}\p{N}])`, "gu");

/**
 * Rewrite LaTeX markup into plain words; text without a backslash, brace or
 * `$` is returned unchanged. Inside `$` math, lone variable letters outside
 * `\text{..}` are dropped too: notation such as `E_c` is written "Ec" or
 * "E c" from page to page, while its numbers, units (`50\text{ W}`) and named
 * quantities carry the claim.
 */
export function canonicalizeLatex(text: string): string {
  if (!/[\\{}$]/.test(text)) return text;
  const plain = rewrite(text.replace(MATH_SPAN, (span) => span.replace(TEXT_OR_LONE_LETTER, (match, text?: string) => text ?? " ")));
  // Single spaces, so a number and its unit ("50 W") still read as one term.
  return plain.replace(/[ \t]{2,}/g, " ");
}

function rewrite(text: string): string {
  let out = text.replace(/\\%/g, "%").replace(/\$/g, " ");
  // Unwrap from the innermost group outwards ("\mathbf{\text{x}}").
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(TEXT_WRAPPER, " $1 ");
  }
  return out
    .replace(/\\([a-zA-Z]+)/g, (_, name: string) => {
      const lower = name.toLowerCase();
      if (GREEK.has(lower)) return ` ${lower.replace(/^var/, "")} `;
      if (FUNCTIONS.has(name)) return ` ${name} `;
      // \frac, \left, \right, \approx, \ge, \times, \cdot and every other command: markup only.
      return " ";
    })
    .replace(/\\./g, " ")
    .replace(/[{}_^]/g, " ");
}
