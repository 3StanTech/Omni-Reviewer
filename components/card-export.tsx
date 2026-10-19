"use client";

import { useMemo } from "react";

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

export type CardExportOption = {
  kind: CardExportKind;
  label: string;
  /** Shown under a disabled option. */
  empty: string;
  count: number;
};

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

/**
 * The pack's card export options (Basic, Cloze, RemNote) with their counts, and the download for each.
 * Carded lists them in its options menu; an option with no cards does nothing.
 */
export function useCardExport(cards: readonly ExportCard[], reviewerName: string) {
  const options = useMemo<CardExportOption[]>(() => [
    { kind: "basic", label: "Basic cards (CSV)", empty: "No basic cards", count: basicExportCards(cards).length },
    { kind: "cloze", label: "Cloze cards (CSV)", empty: "No cloze cards", count: clozeExportCards(cards).length },
    { kind: "remnote", label: "RemNote cards (text)", empty: "No cards", count: cards.filter((card) => !card.archivedAt).length },
  ], [cards]);

  function exportKind(kind: CardExportKind) {
    if (options.find((option) => option.kind === kind)?.count === 0) return;
    const filename = cardExportFilename(reviewerName, kind);
    if (kind === "remnote") {
      downloadFile([cardsToRemNoteText(cards)], "text/plain;charset=utf-8", filename);
      return;
    }
    const csv = kind === "basic" ? cardsToBasicCsv(cards) : cardsToClozeCsv(cards);
    downloadFile(["﻿", csv], "text/csv;charset=utf-8", filename);
  }

  return { options, exportKind };
}
