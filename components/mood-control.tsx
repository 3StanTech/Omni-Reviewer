"use client";

import { Check } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";

import {
  type LookId,
  useLook,
  useSetLook,
} from "@/components/look-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Swatch = the mood's page tone ringed by its accent (values from app/globals.css).
const LOOK_MENU: { id: LookId; label: string; page: string; accent: string }[] = [
  { id: "dreamland", label: "Dream Land", page: "#ffe4ee", accent: "#c2185b" },
  { id: "day", label: "Day", page: "#f3f6fb", accent: "#1d4ed8" },
  { id: "night", label: "Night", page: "#151c2b", accent: "#4fd1c5" },
];

const MOOD_LABEL = "Change today's mood";

export function MoodControl() {
  const look = useLook();
  const setLook = useSetLook();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [finePointer, setFinePointer] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(pointer: fine)");
    const sync = () => setFinePointer(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    }

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function selectLook(next: LookId) {
    setLook(next);
    setOpen(false);
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={() => {
        if (finePointer) setOpen(true);
      }}
      onMouseLeave={() => {
        if (finePointer) setOpen(false);
      }}
      onFocusCapture={() => {
        if (finePointer) setOpen(true);
      }}
      onBlurCapture={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node)) {
          setOpen(false);
        }
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground"
        aria-label={MOOD_LABEL}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="hidden sm:inline">{MOOD_LABEL}</span>
        <span className="sm:hidden">Mood</span>
      </Button>
      <div
        hidden={!open}
        className="absolute top-full right-0 z-50 pt-2"
      >
        <div
          id={menuId}
          role="menu"
          aria-label={MOOD_LABEL}
          className="min-w-44 origin-top-right rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-[0_10px_30px_oklch(0_0_0/40%)] duration-150"
        >
        {LOOK_MENU.map((item) => {
          const selected = item.id === look;
          return (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className={cn(
                "flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors duration-150",
                "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                selected && "bg-accent/70 text-accent-foreground",
              )}
              onClick={() => selectLook(item.id)}
            >
              <span className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="size-[18px] shrink-0 rounded-full border border-black/15"
                  style={{ background: item.page, boxShadow: `inset 0 0 0 5px ${item.accent}` }}
                />
                {item.label}
              </span>
              {selected ? <Check weight="bold" className="size-4" /> : null}
            </button>
          );
        })}
        </div>
      </div>
    </div>
  );
}
