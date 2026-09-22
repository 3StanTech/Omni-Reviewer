"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";

import { hasLossyRichMarkdown } from "@/lib/annotations";

const MdxEditorClient = dynamic(
  () => import("@/components/mdx-editor-client").then((module) => module.MdxEditorClient),
  { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-xl border border-border bg-muted" aria-busy="true" /> },
);

type StudyEditorProps = {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
};

function applySelection(value: string, replacement: string, textarea: HTMLTextAreaElement) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = value.slice(start, end);
  const next = value.slice(0, start) + replacement.replace("$selection", selected) + value.slice(end);
  return { next, cursor: start + replacement.replace("$selection", selected).length };
}

function SourcePreservingEditor({ value, onChange, ariaLabel }: StudyEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  function format(replacement: string) {
    const textarea = ref.current;
    if (!textarea) return;
    const result = applySelection(value, replacement, textarea);
    onChange(result.next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.cursor, result.cursor);
    });
  }
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">
        Source-preserving editor: math and legacy marks stay intact. Use the compact format actions for ordinary selected text.
      </p>
      <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Markdown format actions">
        <button type="button" className="min-h-11 rounded-md border border-border px-3 py-2 text-xs hover:bg-muted" onClick={() => format("**$selection**")}>Bold</button>
        <button type="button" className="min-h-11 rounded-md border border-border px-3 py-2 text-xs hover:bg-muted" onClick={() => format("*$selection*")}>Italic</button>
        <button type="button" className="min-h-11 rounded-md border border-border px-3 py-2 text-xs hover:bg-muted" onClick={() => format("- $selection")}>List</button>
        <button type="button" className="min-h-11 rounded-md border border-border px-3 py-2 text-xs hover:bg-muted" onClick={() => format("> $selection")}>Quote</button>
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-80 w-full resize-y rounded-lg border border-border bg-background p-4 font-mono text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        aria-label={ariaLabel}
      />
    </div>
  );
}

export function StudyEditor(props: StudyEditorProps) {
  if (hasLossyRichMarkdown(props.value)) {
    return <SourcePreservingEditor {...props} />;
  }
  return <MdxEditorClient markdown={props.value} onChange={props.onChange} ariaLabel={props.ariaLabel} />;
}
