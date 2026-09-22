"use client";

import { useEffect, useRef, useState } from "react";

import { ANNOTATION_COLORS, type AnnotationColor } from "@/lib/annotations";
import { Button } from "@/components/ui/button";

type AnnotationMenuProps = {
  quote: string;
  onSave: (color: AnnotationColor, note: string | null) => Promise<boolean>;
  onCancel: () => void;
};

export function AnnotationMenu({ quote, onSave, onCancel }: AnnotationMenuProps) {
  const [color, setColor] = useState<AnnotationColor>("sun");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Tab") {
        const menu = menuRef.current;
        if (!menu) return;
        const focusable = [...menu.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        )];
        if (focusable.length === 0) {
          event.preventDefault();
          menu.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!menu.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
  return (
    <div ref={menuRef} tabIndex={-1} className="annotation-menu rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-[0_12px_32px_oklch(0_0_0/28%)] outline-none focus-visible:ring-3 focus-visible:ring-ring/40" role="dialog" aria-modal="true" aria-label="Highlight or add note">
      <p className="line-clamp-2 max-w-xs text-xs text-muted-foreground">“{quote}”</p>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Highlight color">
        {ANNOTATION_COLORS.map((option) => (
          <button
            key={option}
            type="button"
            aria-label={`${option} highlight`}
            aria-pressed={color === option}
            className={`annotation-color-${option} touch-target rounded-full border-2 ${color === option ? "border-foreground" : "border-transparent"}`}
            onClick={() => setColor(option)}
          />
        ))}
      </div>
      <label className="mt-2 block text-xs font-medium" htmlFor="annotation-note">Note (optional)</label>
      <textarea
        id="annotation-note"
        value={note}
        maxLength={2000}
        onChange={(event) => setNote(event.target.value)}
        className="mt-1 min-h-16 w-full rounded-md border border-border bg-background p-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        placeholder="Why does this matter?"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="button" size="sm" onClick={() => { setBusy(true); void onSave(color, note.trim() || null).finally(() => setBusy(false)); }} disabled={busy}>
          {busy ? "Saving" : note.trim() ? "Save note" : "Highlight"}
        </Button>
      </div>
    </div>
  );
}
