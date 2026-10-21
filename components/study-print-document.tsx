"use client";

import { MarkdownBody } from "@/components/study-markdown";
import type { AnnotationRecord } from "@/lib/annotations";

type StudyPrintDocumentProps = {
  modeLabel: string;
  /** Saved Markdown, or empty when the mode has not been generated. */
  content: string;
  annotations: AnnotationRecord[];
};

/**
 * The Markdown export's "My highlights and notes" as plain text: each quote,
 * then its note. data-annotation-note lets the print CSS drop it with notes off.
 */
function NotesSection({ annotations }: { annotations: AnnotationRecord[] }) {
  return (
    <section data-annotation-note aria-label="My highlights and notes" className="mt-10 space-y-4">
      <h2 className="font-heading text-2xl font-semibold tracking-tight">My highlights and notes</h2>
      {annotations.map((annotation) => {
        const note = annotation.note?.trim();
        return (
          <div key={annotation.id} className="space-y-2 break-inside-avoid">
            <blockquote className="border-l-2 border-border pl-3 whitespace-pre-line text-muted-foreground">
              {annotation.quote.trim()}
            </blockquote>
            {note ? <p className="whitespace-pre-line">{note}</p> : null}
          </div>
        );
      })}
    </section>
  );
}

/**
 * Locked In or Summary as the PDF download renders it: the saved document with
 * its highlights and notes, and none of the workspace around it. The print CSS
 * hides citations or notes from the body's data-export-* attributes.
 */
export function StudyPrintDocument({ modeLabel, content, annotations }: StudyPrintDocumentProps) {
  const activeAnnotations = annotations.filter((annotation) => !annotation.archivedAt);
  const noted = activeAnnotations.filter((annotation) => annotation.quote.trim());
  return (
    <main className="min-h-dvh bg-background px-4 py-6 sm:py-10">
      <article
        aria-label={modeLabel}
        className="print-document reading-surface study-sections mx-auto max-w-4xl rounded-[var(--radius)] border border-border px-5 py-6 shadow-[var(--panel-shadow)] print:border-0 sm:px-8 sm:py-8"
      >
        {content ? (
          <MarkdownBody source={content} annotations={activeAnnotations} hideModePrefix />
        ) : (
          <p className="text-sm text-muted-foreground">{modeLabel} is not generated yet</p>
        )}
        {content && noted.length > 0 ? <NotesSection annotations={noted} /> : null}
      </article>
    </main>
  );
}
