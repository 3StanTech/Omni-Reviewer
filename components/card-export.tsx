"use client";

import { DownloadSimple } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  basicExportCards,
  cardExportFilename,
  cardsToBasicCsv,
  cardsToClozeCsv,
  cardsToRemNoteText,
  clozeExportCards,
  type CardExportKind,
  type ExportCard,
} from "@/lib/card-export";
import { cn } from "@/lib/utils";

type CardExportProps = {
  cards: readonly ExportCard[];
  reviewerName: string;
};

const ITEM_CLASS = cn(
  "flex min-h-11 w-full flex-col items-start justify-center rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors duration-150",
  "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
  "aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent",
);

function downloadFile(parts: BlobPart[], type: string, filename: string) {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function CardExport({ cards, reviewerName }: CardExportProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const basicCount = useMemo(() => basicExportCards(cards).length, [cards]);
  const clozeCount = useMemo(() => clozeExportCards(cards).length, [cards]);
  const liveCount = useMemo(() => cards.filter((card) => !card.archivedAt).length, [cards]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();

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
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
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

  const items: { kind: CardExportKind; label: string; empty: string; count: number }[] = [
    { kind: "basic", label: "Basic cards (CSV)", empty: "No basic cards", count: basicCount },
    { kind: "cloze", label: "Cloze cards (CSV)", empty: "No cloze cards", count: clozeCount },
    { kind: "remnote", label: "RemNote cards (text)", empty: "No cards", count: liveCount },
  ];

  function exportKind(kind: CardExportKind) {
    if (items.find((item) => item.kind === kind)?.count === 0) return;
    close(true);
    const filename = cardExportFilename(reviewerName, kind);
    if (kind === "remnote") {
      downloadFile([cardsToRemNoteText(cards)], "text/plain;charset=utf-8", filename);
      return;
    }
    const csv = kind === "basic" ? cardsToBasicCsv(cards) : cardsToClozeCsv(cards);
    downloadFile(["\uFEFF", csv], "text/csv;charset=utf-8", filename);
  }

  return (
    <div ref={rootRef} className="print-hide relative">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
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
        <DownloadSimple weight="bold" />
        Export cards
      </Button>
      <div hidden={!open} className="absolute top-full right-0 z-50 pt-2">
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Export cards"
          className="min-w-56 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-[0_10px_30px_oklch(0_0_0/40%)]"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => {
            const disabled = item.count === 0;
            const hintId = `${menuId}-${item.kind}-hint`;
            return (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                aria-disabled={disabled || undefined}
                aria-describedby={disabled ? hintId : undefined}
                className={ITEM_CLASS}
                onClick={() => exportKind(item.kind)}
              >
                <span>{item.label}</span>
                {disabled ? (
                  <span id={hintId} className="text-xs text-muted-foreground">
                    {item.empty}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
