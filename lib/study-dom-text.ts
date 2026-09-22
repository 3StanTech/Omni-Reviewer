import { normalizeDocumentText } from "@/lib/annotations";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export type StudyIndexableNode = {
  nodeType: number;
  nodeValue: string | null;
  childNodes: ArrayLike<StudyIndexableNode>;
  tagName?: string;
  classList?: { contains: (name: string) => boolean };
  getAttribute?: (name: string) => string | null;
  querySelector?: (selector: string) => StudyIndexableNode | null;
};

export type StudyDomTextIndex = {
  text: string;
  starts: Map<StudyIndexableNode, number>;
  ends: Map<StudyIndexableNode, number>;
  segments: Map<StudyIndexableNode, { start: number; raw: string }>;
};

const BLOCK_TAGS = /^(H[1-6]|P|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|THEAD|TBODY|TFOOT|TR|TH|TD|HR|SECTION|DIV|ARTICLE)$/;
const FLOW_ROOT_TAGS = /^(ARTICLE|DIV|BLOCKQUOTE|SECTION)$/;
const ROW_PARENT_TAGS = /^(TABLE|THEAD|TBODY|TFOOT)$/;
const LIST_PARENT_TAGS = /^(UL|OL)$/;

function tagNameOf(node: StudyIndexableNode): string | null {
  return node.nodeType === ELEMENT_NODE ? (node.tagName ?? "").toUpperCase() : null;
}

function isBlockElement(node: StudyIndexableNode): boolean {
  const tagName = tagNameOf(node);
  return Boolean(tagName && BLOCK_TAGS.test(tagName));
}

function attr(node: StudyIndexableNode, name: string): string | null {
  return node.getAttribute?.(name) ?? null;
}

function isSkippedFootnoteSurface(node: StudyIndexableNode): boolean {
  const tagName = tagNameOf(node);
  if (!tagName) return false;
  if (attr(node, "data-footnotes") !== null) return true;
  if (attr(node, "data-footnote-ref") !== null) return true;
  if (attr(node, "data-footnote-backref") !== null) return true;
  return Boolean(node.classList?.contains("footnotes"));
}

function childrenOf(node: StudyIndexableNode): StudyIndexableNode[] {
  return Array.from(node.childNodes);
}

function firstDescendant(node: StudyIndexableNode, selector: string): StudyIndexableNode | null {
  const found = node.querySelector?.(selector);
  if (found) return found;
  const wanted = selector.toUpperCase();
  const stack = childrenOf(node);
  while (stack.length) {
    const current = stack.shift();
    if (!current) continue;
    if (tagNameOf(current) === wanted) return current;
    stack.unshift(...childrenOf(current));
  }
  return null;
}

function domSeparator(
  parentTag: string | null,
  previous: StudyIndexableNode | undefined,
  next: StudyIndexableNode,
): string {
  if (!parentTag || !previous || !isBlockElement(previous) || !isBlockElement(next)) return "";
  if (parentTag === "LI") return "\n";
  if (FLOW_ROOT_TAGS.test(parentTag)) return "\n\n";
  if (LIST_PARENT_TAGS.test(parentTag) || ROW_PARENT_TAGS.test(parentTag)) return "\n";
  if (parentTag === "TR") return "\t";
  return "";
}

/**
 * Walk a rendered study DOM with the same block/table separators as
 * `renderedStudyTextModel`. Wrapper DIVs from the Markdown body are flow
 * roots, matching mdast root/blockquote spacing.
 */
export function buildStudyDomTextIndex(root: StudyIndexableNode | HTMLElement): StudyDomTextIndex {
  return indexStudyDom(root as StudyIndexableNode);
}

function indexStudyDom(root: StudyIndexableNode): StudyDomTextIndex {
  let text = "";
  const starts = new Map<StudyIndexableNode, number>();
  const ends = new Map<StudyIndexableNode, number>();
  const segments = new Map<StudyIndexableNode, { start: number; raw: string }>();

  function visit(node: StudyIndexableNode) {
    starts.set(node, text.length);
    if (node.nodeType === ELEMENT_NODE) {
      const tagName = tagNameOf(node) ?? "";
      if (tagName === "MATH" || node.classList?.contains("katex")) {
        const annotation = firstDescendant(node, "annotation");
        text += normalizeDocumentText(descendantText(annotation));
        ends.set(node, text.length);
        return;
      }
      if (tagName === "PRE") {
        const code = firstDescendant(node, "code");
        text += normalizeDocumentText(code ? descendantText(code) : descendantText(node)).replace(/\n$/, "");
        ends.set(node, text.length);
        return;
      }
      if (tagName === "BR") {
        text += "\n";
        ends.set(node, text.length);
        return;
      }
      if (tagName === "ANNOTATION" || attr(node, "aria-hidden") === "true" || isSkippedFootnoteSurface(node)) {
        ends.set(node, text.length);
        return;
      }
    }
    if (node.nodeType === TEXT_NODE) {
      const raw = node.nodeValue ?? "";
      segments.set(node, { start: text.length, raw });
      text += normalizeDocumentText(raw);
      ends.set(node, text.length);
      return;
    }
    const parentTag = tagNameOf(node);
    const children = childrenOf(node);
    let previous: StudyIndexableNode | undefined;
    for (const child of children) {
      text += domSeparator(parentTag, previous, child);
      visit(child);
      previous = child;
    }
    ends.set(node, text.length);
  }

  visit(root);
  return { text, starts, ends, segments };
}

function descendantText(node: StudyIndexableNode | null | undefined): string {
  if (!node) return "";
  if (node.nodeType === TEXT_NODE) return node.nodeValue ?? "";
  let output = "";
  for (const child of childrenOf(node)) output += descendantText(child);
  return output;
}

export function canonicalOffsetForPoint(
  index: StudyDomTextIndex,
  container: StudyIndexableNode,
  offset: number,
): number | null {
  const segment = index.segments.get(container);
  if (segment) {
    const bounded = Math.max(0, Math.min(offset, segment.raw.length));
    return segment.start + normalizeDocumentText(segment.raw.slice(0, bounded)).length;
  }
  const children = childrenOf(container);
  if (offset < children.length) return index.starts.get(children[offset]) ?? null;
  return index.ends.get(container) ?? null;
}

export function rangeOffsetsForStudyDom(
  root: StudyIndexableNode | HTMLElement,
  range: { startContainer: StudyIndexableNode | Node; startOffset: number; endContainer: StudyIndexableNode | Node; endOffset: number },
  index: StudyDomTextIndex,
): { startOffset: number; endOffset: number } | null {
  const elementRoot = typeof HTMLElement !== "undefined" && root instanceof HTMLElement ? root : null;
  if (elementRoot && range.startContainer instanceof Node && !elementRoot.contains(range.startContainer)) return null;
  if (elementRoot && range.endContainer instanceof Node && !elementRoot.contains(range.endContainer)) return null;
  const startOffset = canonicalOffsetForPoint(index, range.startContainer as StudyIndexableNode, range.startOffset);
  const endOffset = canonicalOffsetForPoint(index, range.endContainer as StudyIndexableNode, range.endOffset);
  if (startOffset === null || endOffset === null || startOffset === endOffset) return null;
  return startOffset < endOffset
    ? { startOffset, endOffset }
    : { startOffset: endOffset, endOffset: startOffset };
}
