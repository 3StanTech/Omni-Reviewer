/**
 * Export builders for Locked In and Summary. Pure so the Markdown download can
 * be tested without a browser; the PDF path uses browser print and CSS only.
 */

import type { AnnotationRecord } from "@/lib/annotations";
import { stripCitations, UNSOURCED_TOKEN } from "@/lib/citations";
import { stripPageMarkers } from "@/lib/source-markers";

export const UNSOURCED_EXPORT_TEXT = "(not from your uploaded sources)";

/** The client annotation fields an export reads. */
export type ExportAnnotation = Pick<AnnotationRecord, "quote" | "note" | "color" | "archivedAt">;

export type MarkdownExportInput = {
  title: string;
  modeLabel: string;
  markdown: string;
  keepCitations: boolean;
  includeNotes: boolean;
  annotations: readonly ExportAnnotation[];
};

const MAX_FILENAME_LENGTH = 120;

function replaceUnsourced(text: string): string {
  return text
    .split(UNSOURCED_TOKEN)
    .reduce((out, part, index) => {
      if (index === 0) return part;
      const needsSpace = out.length > 0 && !/\s$/.test(out);
      return `${out}${needsSpace ? " " : ""}${UNSOURCED_EXPORT_TEXT}${part}`;
    }, "");
}

function blockquote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

function notesSection(annotations: readonly ExportAnnotation[]): string | null {
  const active = annotations.filter((annotation) => !annotation.archivedAt && annotation.quote.trim());
  if (active.length === 0) return null;
  const items = active.map((annotation) => {
    const note = annotation.note?.trim();
    return note ? `${blockquote(annotation.quote)}\n\n${note}` : blockquote(annotation.quote);
  });
  return `## My highlights and notes\n\n${items.join("\n\n")}`;
}

export function buildMarkdownExport({
  title,
  modeLabel,
  markdown,
  keepCitations,
  includeNotes,
  annotations,
}: MarkdownExportInput): string {
  let body = replaceUnsourced(stripPageMarkers(markdown));
  if (!keepCitations) body = stripCitations(body);
  body = body.trim();

  const parts = [`# ${title.trim()}: ${modeLabel.trim()}`];
  if (body) parts.push(body);
  if (includeNotes) {
    const notes = notesSection(annotations);
    if (notes) parts.push(notes);
  }
  return `${parts.join("\n\n")}\n`;
}

export function safeSegment(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
}

/** Safe download name: "<name> - <mode><extension>", at most 120 characters. */
export function exportFilename(reviewerName: string, modeLabel: string, extension: ".md" | ".pdf" = ".md"): string {
  const name = safeSegment(reviewerName) || "Pack";
  const mode = safeSegment(modeLabel);
  const suffix = extension;
  let base = mode ? `${name} - ${mode}` : name;
  if (base.length + suffix.length > MAX_FILENAME_LENGTH) {
    base = base.slice(0, MAX_FILENAME_LENGTH - suffix.length).trimEnd().replace(/[.\s-]+$/, "");
  }
  return `${base || "Pack"}${suffix}`;
}
