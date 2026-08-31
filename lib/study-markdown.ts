/** Shared bounds for every study-mode Markdown render. */
export const MAX_STUDY_MARKDOWN_CHARS = 100_000;
export const MAX_STUDY_MATH_CHARS = 12_000;
export const MAX_STUDY_MATH_BLOCKS = 200;

export type PreparedStudyMarkdown = {
  source: string;
  mathBlocks: number;
  mathChars: number;
};

type MathScan = { blocks: number; chars: number };

/**
 * Count complete math delimiters with a single forward state machine. An
 * opener owns the input cursor until its matching closer or its bounded end
 * (the end of the document for display/slash math, or the end of the line for
 * inline math), so unmatched repeated openers cannot rescan a suffix.
 */
function scanMath(source: string): MathScan {
  let blocks = 0;
  let chars = 0;
  let index = 0;
  let close: "$" | "$$" | "\\)" | "\\]" | null = null;
  let openStart = -1;
  let contentStart = -1;
  let inline = false;

  while (index < source.length) {
    if (close !== null) {
      const isClose =
        close === "$"
          ? source[index] === "$" && index > contentStart
          : close === "$$"
            ? source[index] === "$" && source[index + 1] === "$"
            : source[index] === close[0] && source[index + 1] === close[1];
      if (isClose) {
        const end = index + close.length;
        blocks += 1;
        chars += end - openStart;
        index = end;
        close = null;
        openStart = -1;
        contentStart = -1;
        inline = false;
        continue;
      }
      if (inline && source[index] === "\n") {
        // Match remark-math's single-line inline delimiter behavior and move
        // past the newline so the same suffix is never inspected twice.
        close = null;
        openStart = -1;
        contentStart = -1;
        inline = false;
      } else {
        index += 1;
        continue;
      }
    }

    if (source.startsWith("$$", index)) {
      close = "$$";
      openStart = index;
      contentStart = index + 2;
      inline = false;
      index += 2;
      continue;
    }
    if (source.startsWith("\\(", index)) {
      close = "\\)";
      openStart = index;
      contentStart = index + 2;
      inline = false;
      index += 2;
      continue;
    }
    if (source.startsWith("\\[", index)) {
      close = "\\]";
      openStart = index;
      contentStart = index + 2;
      inline = false;
      index += 2;
      continue;
    }
    if (source[index] === "$") {
      close = "$";
      openStart = index;
      contentStart = index + 1;
      inline = true;
      index += 1;
      continue;
    }
    index += 1;
  }

  return { blocks, chars };
}

/**
 * Check render cost before unified/KaTeX sees user- or model-authored text.
 * Returning null intentionally fails closed instead of silently truncating
 * study material.
 */
export function prepareStudyMarkdown(
  source: string | null | undefined,
): PreparedStudyMarkdown | null {
  if (typeof source !== "string") return null;
  if (source.length > MAX_STUDY_MARKDOWN_CHARS) return null;

  const math = scanMath(source);
  if (math.blocks > MAX_STUDY_MATH_BLOCKS || math.chars > MAX_STUDY_MATH_CHARS) {
    return null;
  }

  return { source, mathBlocks: math.blocks, mathChars: math.chars };
}
