import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { z } from "zod";

export const ANNOTATION_COLORS = ["sun", "sky", "mint", "rose"] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

export const MAX_ANNOTATION_NOTE_CHARS = 2_000;
export const MAX_ANNOTATION_QUOTE_CHARS = 10_000;
export const MAX_ANNOTATION_CONTEXT_CHARS = 500;
export const MAX_ACTIVE_ANNOTATIONS = 500;
export const DEFAULT_EARLIER_ANNOTATION_PAGE_SIZE = 50;

export type AnnotationRecord = {
  id: string;
  reviewerId: string;
  viewId: string;
  kind: "locked_in" | "summary";
  contentRevision: number;
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix: string;
  suffix: string;
  color: AnnotationColor;
  note: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnnotationDraft = {
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix?: string;
  suffix?: string;
  color: AnnotationColor;
  note?: string | null;
};

export const annotationDraftSchema = z.object({
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  quote: z.string().trim().min(1).max(MAX_ANNOTATION_QUOTE_CHARS),
  prefix: z.string().max(MAX_ANNOTATION_CONTEXT_CHARS).optional().default(""),
  suffix: z.string().max(MAX_ANNOTATION_CONTEXT_CHARS).optional().default(""),
  color: z.enum(ANNOTATION_COLORS),
  note: z.string().max(MAX_ANNOTATION_NOTE_CHARS).nullable().optional().default(null),
}).strict();

/**
 * Annotation offsets are offsets into the reader's normalized rendered text,
 * not offsets into Markdown source. NFC is deliberately applied before the
 * Markdown parser so client DOM offsets and server validation use the same
 * UTF-16 coordinate space.
 */
export function normalizeDocumentText(source: string): string {
  return source.replace(/\r\n?/g, "\n").normalize("NFC");
}

type StudyNode = {
  type: string;
  value?: string;
  children?: StudyNode[];
  data?: unknown;
};

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

const FOOTNOTE_NODE_TYPES = new Set(["footnote", "footnoteDefinition", "footnoteReference"]);

function dropUnsupportedFootnoteNodes(node: StudyNode): void {
  if (!node.children?.length) return;
  node.children = node.children.filter((child) => !FOOTNOTE_NODE_TYPES.has(child.type));
  for (const child of node.children) dropUnsupportedFootnoteNodes(child);
}

/** GFM footnotes are not an annotation surface; drop them from every study parser. */
export function remarkDropStudyFootnotes() {
  return (tree: StudyNode) => {
    dropUnsupportedFootnoteNodes(tree);
  };
}

function parseStudyTree(source: string): StudyNode {
  const tree = markdownParser.parse(normalizeDocumentText(source)) as unknown as StudyNode;
  dropUnsupportedFootnoteNodes(tree);
  return tree;
}

function isBlockNode(node: StudyNode): boolean {
  return new Set([
    "heading",
    "paragraph",
    "blockquote",
    "list",
    "code",
    "thematicBreak",
    "table",
    "html",
  ]).has(node.type);
}

function separatorBetween(parent: StudyNode, previous: StudyNode | undefined, next: StudyNode): string {
  if (!previous) return "";
  if (parent.type === "root" && isBlockNode(previous) && isBlockNode(next)) return "\n\n";
  if (parent.type === "blockquote" && isBlockNode(previous) && isBlockNode(next)) return "\n\n";
  if (parent.type === "list" && previous.type === "listItem" && next.type === "listItem") return "\n";
  if (parent.type === "listItem" && isBlockNode(previous) && isBlockNode(next)) return "\n";
  if ((parent.type === "table" || parent.type === "tableHead" || parent.type === "tableBody") && previous.type === "tableRow" && next.type === "tableRow") return "\n";
  if (parent.type === "tableRow" && previous.type === "tableCell" && next.type === "tableCell") return "\t";
  return "";
}

function visibleNodeText(node: StudyNode): string {
  if (FOOTNOTE_NODE_TYPES.has(node.type)) return "";
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code" || node.type === "inlineMath" || node.type === "math") {
    return normalizeDocumentText(node.value ?? "");
  }
  if (node.type === "break") return "\n";
  // Raw HTML is dropped by the reader's skipHtml/sanitize pipeline. Allowlisted
  // legacy span wrappers are converted into child text by the reader plugin;
  // their wrapper nodes therefore contribute no text here.
  if (node.type === "html" || node.type === "image" || node.type === "definition" || node.type === "yaml") return "";
  if (!node.children?.length) return "";
  let output = "";
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    output += separatorBetween(node, node.children[index - 1], child);
    output += visibleNodeText(child);
  }
  return output;
}

export type RenderedStudyTextModel = {
  text: string;
  tree: StudyNode | null;
};

function fallbackRenderedText(source: string): string {
  return normalizeDocumentText(source)
    .replace(/<[^>]+>/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^[ \t]{0,3}(?:[-*+]\s+|\d+[.)]\s+|>\s+)/gm, "")
    .replace(/!??\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[|*_`~]/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** Build the one canonical text model shared by validation, remapping, and UI. */
export function renderedStudyTextModel(source: string): RenderedStudyTextModel {
  try {
    const tree = parseStudyTree(source);
    return { text: visibleNodeText(tree), tree };
  } catch {
    // Fail closed for malformed Markdown while retaining the old readable
    // behavior for content the parser cannot inspect.
    return { text: fallbackRenderedText(source), tree: null };
  }
}

export function renderedStudyText(source: string): string {
  return renderedStudyTextModel(source).text;
}

function isTrailingSurrogate(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const code = text.charCodeAt(index);
  return code >= 0xDC00 && code <= 0xDFFF;
}

/** Inclusive start index that does not land on a trailing UTF-16 surrogate. */
export function clampUtf16Start(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  return isTrailingSurrogate(text, index) ? index - 1 : index;
}

/** Exclusive end index that does not split a UTF-16 surrogate pair. */
export function clampUtf16End(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  return isTrailingSurrogate(text, index) ? Math.min(text.length, index + 1) : index;
}

export function contextForRange(
  source: string,
  startOffset: number,
  endOffset: number,
): { prefix: string; suffix: string } {
  const normalized = normalizeDocumentText(source);
  const rangeStart = clampUtf16Start(normalized, startOffset);
  const rangeEnd = clampUtf16End(normalized, endOffset);
  const prefixStart = clampUtf16Start(
    normalized,
    Math.max(0, rangeStart - MAX_ANNOTATION_CONTEXT_CHARS),
  );
  const suffixEnd = clampUtf16End(
    normalized,
    Math.min(normalized.length, rangeEnd + MAX_ANNOTATION_CONTEXT_CHARS),
  );
  return {
    prefix: normalized.slice(prefixStart, rangeStart),
    suffix: normalized.slice(rangeEnd, suffixEnd),
  };
}

export type ValidatedAnnotationDraft = AnnotationDraft & {
  prefix: string;
  suffix: string;
  note: string | null;
};

/** Return true when two half-open canonical text ranges overlap. */
export function annotationRangesOverlap(
  left: Pick<AnnotationDraft, "startOffset" | "endOffset">,
  right: Pick<AnnotationDraft, "startOffset" | "endOffset">,
): boolean {
  return left.startOffset < right.endOffset && right.startOffset < left.endOffset;
}

/**
 * The renderer uses this same deterministic policy for legacy overlapping
 * rows: earliest start wins, then the longest range, then stable id. New API
 * writes reject overlap instead of relying on the renderer to hide data.
 */
export function selectRenderableAnnotations<T extends Pick<AnnotationRecord, "id" | "startOffset" | "endOffset" | "archivedAt">>(annotations: T[]): T[] {
  const accepted: T[] = [];
  const candidates = annotations
    .filter((annotation) => !annotation.archivedAt && annotation.endOffset > annotation.startOffset)
    .sort((left, right) =>
      left.startOffset - right.startOffset ||
      (right.endOffset - right.startOffset) - (left.endOffset - left.startOffset) ||
      left.id.localeCompare(right.id),
    );
  for (const candidate of candidates) {
    if (accepted.some((existing) => annotationRangesOverlap(existing, candidate))) continue;
    accepted.push(candidate);
  }
  return accepted.sort((left, right) => left.startOffset - right.startOffset || left.id.localeCompare(right.id));
}

/** Validate one draft against the canonical normalized rendered text. */
export function validateAnnotationDraft(
  source: string,
  draft: AnnotationDraft,
  model: RenderedStudyTextModel = renderedStudyTextModel(source),
): ValidatedAnnotationDraft | null {
  const parsed = annotationDraftSchema.safeParse(draft);
  if (!parsed.success) return null;
  const normalized = model.text;
  const { startOffset, endOffset, quote } = parsed.data;
  if (startOffset >= endOffset || endOffset > normalized.length) return null;
  if (normalized.slice(startOffset, endOffset) !== quote) return null;
  if (!annotationRangeCanRenderModel(model, startOffset, endOffset)) return null;
  const context = contextForRange(normalized, startOffset, endOffset);
  const prefix = parsed.data.prefix || context.prefix;
  const suffix = parsed.data.suffix || context.suffix;
  if (!context.prefix.endsWith(prefix) || !context.suffix.startsWith(suffix)) return null;
  return {
    ...parsed.data,
    prefix,
    suffix,
    note: parsed.data.note?.trim() || null,
  };
}

/** Validate a batch and reject overlaps before it reaches the database. */
export function validateAnnotationBatch(
  source: string,
  drafts: AnnotationDraft[],
): ValidatedAnnotationDraft[] | null {
  const model = renderedStudyTextModel(source);
  const validated = drafts.map((draft) => validateAnnotationDraft(source, draft, model));
  if (validated.some((item) => !item)) return null;
  const rows = validated.filter((item): item is ValidatedAnnotationDraft => item !== null);
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      if (annotationRangesOverlap(rows[left], rows[right])) return null;
    }
  }
  return rows;
}

export type RemappedAnnotation = {
  id: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix: string;
  suffix: string;
  contentRevision: number;
};

type AnnotationRemapInput = {
  id: string;
  mapped: boolean;
  startOffset?: number;
  endOffset?: number;
  quote?: string;
  prefix?: string;
  suffix?: string;
  contentRevision?: number;
};

type AnnotationSaveInput = {
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix: string;
  suffix: string;
  color: string;
  note: string | null;
};

/** `jsonb_to_recordset` reads snake_case keys. Camel-case JSON leaves offsets null. */
export function annotationSaveRows(items: readonly AnnotationSaveInput[]) {
  return items.map((item) => ({
    start_offset: item.startOffset,
    end_offset: item.endOffset,
    quote: item.quote,
    prefix: item.prefix,
    suffix: item.suffix,
    color: item.color,
    note: item.note,
  }));
}

export function annotationRemapRows(items: readonly AnnotationRemapInput[]) {
  return items.map((item) => item.mapped
    ? {
      id: item.id,
      mapped: true,
      start_offset: item.startOffset ?? null,
      end_offset: item.endOffset ?? null,
      quote: item.quote ?? null,
      prefix: item.prefix ?? null,
      suffix: item.suffix ?? null,
      content_revision: item.contentRevision ?? null,
    }
    : {
      id: item.id,
      mapped: false,
      start_offset: null,
      end_offset: null,
      quote: null,
      prefix: null,
      suffix: null,
      content_revision: null,
    });
}

type RemapAnchor = Pick<AnnotationRecord, "id" | "quote"> &
  Partial<Pick<AnnotationRecord, "prefix" | "suffix">>;

const MAX_REMAP_OCCURRENCES = 8;

function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  if (!quote) return found;
  for (let offset = text.indexOf(quote); offset >= 0; offset = text.indexOf(quote, offset + quote.length)) {
    found.push(offset);
    if (found.length > MAX_REMAP_OCCURRENCES) return [];
  }
  return found;
}

/**
 * Preserve an anchor when its quote has one new occurrence; use the stored
 * context only to disambiguate repeated phrases. Ambiguous or removed quotes
 * stay Earlier version instead of being guessed.
 */
export function remapAnnotation(
  annotation: RemapAnchor,
  nextSource: string,
  nextContentRevision: number,
  model: RenderedStudyTextModel = renderedStudyTextModel(nextSource),
): RemappedAnnotation | null {
  const normalized = model.text;
  const quote = normalizeDocumentText(annotation.quote);
  const prefix = normalizeDocumentText(annotation.prefix ?? "");
  const suffix = normalizeDocumentText(annotation.suffix ?? "");
  const candidates = occurrences(normalized, quote);
  const matches = candidates.length <= 1 ? candidates : candidates.filter((start) => {
    const context = contextForRange(normalized, start, start + quote.length);
    return (!prefix || context.prefix.endsWith(prefix)) &&
      (!suffix || context.suffix.startsWith(suffix));
  });
  if (matches.length !== 1) return null;
  const startOffset = matches[0];
  const endOffset = startOffset + quote.length;
  if (!annotationRangeCanRenderModel(model, startOffset, endOffset)) return null;
  const context = contextForRange(normalized, startOffset, endOffset);
  return {
    id: annotation.id,
    startOffset,
    endOffset,
    quote,
    prefix: context.prefix,
    suffix: context.suffix,
    contentRevision: nextContentRevision,
  };
}

type AnnotationLike = Pick<AnnotationRecord, "id" | "startOffset" | "endOffset" | "archivedAt" | "color">;

function annotationSpanNode(className: string, children: StudyNode[]): StudyNode {
  return {
    type: "annotationSpan",
    children,
    data: { hName: "span", hProperties: { className: [`user-annotation-${className}`] } },
  };
}

/**
 * Code blocks and display math do not expose a selectable rendered-text
 * surface. Inline code/math can be wrapped only when the whole leaf is part
 * of an annotation; rejecting partial leaves prevents a saved highlight from
 * silently disappearing in the reader.
 */
function annotationRangeCanRenderModel(model: RenderedStudyTextModel, start: number, end: number): boolean {
  if (!model.tree || start >= end || end > model.text.length) return false;
  let cursor = 0;
  let renderable = true;
  function visit(node: StudyNode) {
    if (FOOTNOTE_NODE_TYPES.has(node.type)) return;
    if (node.type === "text" || node.type === "inlineCode" || node.type === "code" || node.type === "inlineMath" || node.type === "math") {
      const nodeStart = cursor;
      cursor += visibleNodeText(node).length;
      const nodeEnd = cursor;
      const intersects = start < nodeEnd && end > nodeStart;
      if (intersects && (node.type === "code" || node.type === "math")) renderable = false;
      if (intersects && (node.type === "inlineCode" || node.type === "inlineMath") && !(start <= nodeStart && end >= nodeEnd)) {
        renderable = false;
      }
      return;
    }
    if (node.type === "break") {
      cursor += 1;
      return;
    }
    if (!node.children?.length) return;
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index];
      cursor += separatorBetween(node, node.children[index - 1], child).length;
      visit(child);
    }
  }
  visit(model.tree);
  return renderable;
}

/**
 * Code blocks and display math do not expose a selectable rendered-text
 * surface. Inline code/math can be wrapped only when the whole leaf is part
 * of an annotation; rejecting partial leaves prevents a saved highlight from
 * silently disappearing in the reader. GFM footnotes are unsupported.
 */
export function annotationRangeCanRender(source: string, start: number, end: number): boolean {
  return annotationRangeCanRenderModel(renderedStudyTextModel(source), start, end);
}

/** Keep extra loaded Earlier rows when a mutation returns only the first page. */
export function mergeAnnotationRecords(
  current: AnnotationRecord[],
  incoming: AnnotationRecord[],
): AnnotationRecord[] {
  const seen = new Set<string>();
  const merged: AnnotationRecord[] = [];
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  for (const row of current) {
    if (seen.has(row.id) || !row.archivedAt) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

export function nextEarlierCursorAfterMerge(
  currentCursor: string | null,
  incomingCursor: string | null | undefined,
  current: AnnotationRecord[],
  incoming: AnnotationRecord[],
): string | null {
  const currentEarlier = current.filter((row) => row.archivedAt).length;
  const incomingEarlier = incoming.filter((row) => row.archivedAt).length;
  if (currentEarlier > incomingEarlier) return currentCursor;
  return incomingCursor ?? null;
}

function transformNode(node: StudyNode, startOffset: number, ranges: AnnotationLike[]): { nodes: StudyNode[]; endOffset: number } {
  if (node.type === "text") {
    const value = normalizeDocumentText(node.value ?? "");
    const endOffset = startOffset + value.length;
    if (!value || ranges.length === 0) return { nodes: [node], endOffset };
    const boundaries = new Set<number>([0, value.length]);
    for (const range of ranges) {
      if (range.endOffset <= startOffset || range.startOffset >= endOffset) continue;
      boundaries.add(Math.max(0, range.startOffset - startOffset));
      boundaries.add(Math.min(value.length, range.endOffset - startOffset));
    }
    const sorted = [...boundaries].sort((left, right) => left - right);
    const children: StudyNode[] = [];
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const localStart = sorted[index];
      const localEnd = sorted[index + 1];
      if (localEnd <= localStart) continue;
      const absoluteStart = startOffset + localStart;
      const absoluteEnd = startOffset + localEnd;
      const owner = ranges.find((range) => range.startOffset <= absoluteStart && range.endOffset >= absoluteEnd);
      const textNode: StudyNode = { type: "text", value: value.slice(localStart, localEnd) };
      children.push(owner ? annotationSpanNode(owner.color, [textNode]) : textNode);
    }
    return { nodes: children, endOffset };
  }

  if (!node.children?.length) {
    const leafText = visibleNodeText(node);
    const endOffset = startOffset + leafText.length;
    if ((node.type === "inlineCode" || node.type === "inlineMath") && leafText && ranges.length) {
      const owner = ranges.find((range) => range.startOffset <= startOffset && range.endOffset >= endOffset);
      if (owner) return { nodes: [annotationSpanNode(owner.color, [node])], endOffset };
    }
    return { nodes: [node], endOffset };
  }

  let cursor = startOffset;
  const nextChildren: StudyNode[] = [];
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    cursor += separatorBetween(node, node.children[index - 1], child).length;
    const transformed = transformNode(child, cursor, ranges);
    nextChildren.push(...transformed.nodes);
    cursor = transformed.endOffset;
  }
  node.children = nextChildren;
  return { nodes: [node], endOffset: cursor };
}

/** Remark plugin used by the reader so formatting, links, tables and Unicode
 * annotations are rendered from the exact same canonical model as the API. */
export function remarkStudyAnnotations(annotations: AnnotationRecord[]) {
  return () => (tree: StudyNode) => {
    const ranges = selectRenderableAnnotations(annotations);
    transformNode(tree, 0, ranges);
  };
}

export function hasLossyRichMarkdown(source: string): boolean {
  return /(?:\$\$?[\s\S]*?\$\$?|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|<span\b[^>]*\b(?:ink-(?:idea|example|fact|warning|exam))\b)/i.test(source);
}
