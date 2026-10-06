"use client";

import { Check, DownloadSimple } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildMarkdownExport, exportFilename, type ExportAnnotation } from "@/lib/study-export";

type StudyExportProps = {
  topicId: string;
  reviewerId: string;
  reviewerName: string;
  modeLabel: string;
  markdown: string;
  annotations: ExportAnnotation[];
};

const ITEM_CLASS = cn(
  "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors duration-150",
  "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
);

function clearPrintFlags() {
  delete document.body.dataset.exportCitations;
  delete document.body.dataset.exportAnnotations;
}

export function StudyExport({ topicId, reviewerId, reviewerName, modeLabel, markdown, annotations }: StudyExportProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [keepCitations, setKeepCitations] = useState(true);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next >= 0) {
      event.preventDefault();
      items[next].focus();
    }
  }

  function exportPdf() {
    close(true);
    const body = document.body;
    body.dataset.exportCitations = keepCitations ? "on" : "off";
    body.dataset.exportAnnotations = includeNotes ? "on" : "off";
    window.addEventListener("afterprint", clearPrintFlags, { once: true });
    window.print();
  }

  function openPacket() {
    close(true);
    window.open(`/topics/${topicId}/reviewers/${reviewerId}/packet?print=1`, "_blank", "noopener");
  }

  function exportMarkdown() {
    close(true);
    const text = buildMarkdownExport({
      title: reviewerName,
      modeLabel,
      markdown,
      keepCitations,
      includeNotes,
      annotations,
    });
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(reviewerName, modeLabel);
    link.rel = "noopener";
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div ref={rootRef} className="print-hide relative">
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <DownloadSimple />
        Download
      </Button>
      <div hidden={!open} className="absolute top-full left-0 z-50 pt-2">
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={`Download ${modeLabel}`}
          className="min-w-64 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-[0_10px_30px_oklch(0_0_0/40%)]"
          onKeyDown={onMenuKeyDown}
        >
          <button type="button" role="menuitem" className={ITEM_CLASS} onClick={exportPdf}>
            PDF
          </button>
          <button type="button" role="menuitem" className={ITEM_CLASS} onClick={exportMarkdown}>
            Markdown (.md)
          </button>
          <button type="button" role="menuitem" className={ITEM_CLASS} onClick={openPacket}>
            Study packet (PDF)
          </button>
          <div role="separator" className="my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={includeNotes}
            className={ITEM_CLASS}
            onClick={() => setIncludeNotes((current) => !current)}
          >
            <span className="flex size-4 shrink-0 items-center justify-center rounded border border-border">
              {includeNotes ? <Check weight="bold" className="size-3" /> : null}
            </span>
            Include highlights and notes
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={keepCitations}
            className={ITEM_CLASS}
            onClick={() => setKeepCitations((current) => !current)}
          >
            <span className="flex size-4 shrink-0 items-center justify-center rounded border border-border">
              {keepCitations ? <Check weight="bold" className="size-3" /> : null}
            </span>
            Include slide citations
          </button>
        </div>
      </div>
    </div>
  );
}
