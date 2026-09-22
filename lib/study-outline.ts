import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";

import { remarkDropStudyFootnotes } from "@/lib/annotations";

export type StudyHeading = { id: string; text: string; level: number };

type HeadingNode = {
  type: string;
  depth?: number;
  children?: unknown[];
  data?: {
    hProperties?: Record<string, unknown>;
  };
};

/** Ids produced by `slugify`, including duplicate suffixes such as `section-2`. */
export const STUDY_HEADING_ID_PATTERN = /^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u;

/**
 * Prefix applied by the study sanitizer's id clobber protection.
 * Outline links must use this same prefix; clearing it would disable that protection.
 */
export const STUDY_HEADING_CLOBBER_PREFIX = "user-content-";

export function outlineHeadingHref(headingId: string): string {
  const id = headingId.startsWith(STUDY_HEADING_CLOBBER_PREFIX)
    ? headingId
    : `${STUDY_HEADING_CLOBBER_PREFIX}${headingId}`;
  return `#${id}`;
}

type RootNode = { children?: HeadingNode[] };

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkDropStudyFootnotes).use(remarkMath);

function slugify(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "") || "section";
}

function headingText(node: HeadingNode): string {
  if (node.type === "html") return "";
  if (node.children?.length) {
    return node.children
      .map((child) => headingText(child as HeadingNode))
      .join("");
  }
  const value = (node as HeadingNode & { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

/**
 * Parse headings with the same Markdown parser used by the reader. This keeps
 * formatted headings (emphasis, links, code, Unicode and setext headings) in
 * lockstep with rendered heading ids instead of stringifying React children.
 */
function headingEntries(tree: RootNode): StudyHeading[] {
  const counts = new Map<string, number>();
  const headings: StudyHeading[] = [];
  for (const node of tree.children ?? []) {
    if (node.type !== "heading") continue;
    const text = headingText(node).trim();
    const base = slugify(text);
    const next = (counts.get(base) ?? 0) + 1;
    counts.set(base, next);
    const id = next === 1 ? base : `${base}-${next}`;
    node.data = {
      ...node.data,
      hProperties: { ...node.data?.hProperties, id },
    };
    headings.push({
      id,
      text,
      level: Math.min(6, Math.max(1, node.depth ?? 1)),
    });
  }
  return headings;
}

/**
 * Stamp heading ids onto the Markdown tree. The reader uses these properties
 * so a repeated React render cannot advance a shared heading counter.
 */
export function remarkStudyHeadingIds() {
  return (tree: RootNode) => {
    headingEntries(tree);
  };
}

export function studyOutline(markdown: string): StudyHeading[] {
  let tree: RootNode;
  try {
    tree = markdownParser.runSync(
      markdownParser.parse(markdown.replace(/\r\n?/g, "\n")),
    ) as unknown as RootNode;
  } catch {
    return [];
  }
  return headingEntries(tree);
}

export function headingIds(markdown: string): string[] {
  return studyOutline(markdown).map((heading) => heading.id);
}
