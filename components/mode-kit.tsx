"use client";

import { BookOpen, Cards, ListChecks, Note } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

import type { ViewKind } from "@/lib/types";
import { cn } from "@/lib/utils";

export const MODE_KIT_ITEMS: {
  kind: ViewKind;
  label: string;
  job: string;
  Icon: Icon;
}[] = [
  {
    kind: "locked_in",
    label: "Locked In",
    job: "Full study document.",
    Icon: BookOpen,
  },
  {
    kind: "summary",
    label: "Summary",
    job: "Last-minute review.",
    Icon: Note,
  },
  {
    kind: "test_me",
    label: "Test Me",
    job: "Sit the exam.",
    Icon: ListChecks,
  },
  {
    kind: "carded",
    label: "Carded",
    job: "Remember over time.",
    Icon: Cards,
  },
];

type ModeKitProps = {
  value: ViewKind;
  onChange: (kind: ViewKind) => void;
};

export function ModeKit({ value, onChange }: ModeKitProps) {
  return (
    <div
      role="group"
      aria-label="Study mode destinations"
      className="grid grid-cols-2 gap-3 sm:grid-cols-4"
    >
      {MODE_KIT_ITEMS.map(({ kind, label, job, Icon }) => {
        const selected = value === kind;
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(kind)}
            className={cn(
              "flex min-h-32 flex-col items-start gap-2 rounded-[var(--radius)] border bg-card p-4 text-left text-card-foreground transition-colors duration-200",
              selected
                ? "border-primary bg-primary/10"
                : "border-border hover:border-primary/40",
            )}
          >
            <Icon className="size-5 text-primary" weight="regular" />
            <span className="text-sm font-semibold tracking-tight">{label}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {job}
            </span>
          </button>
        );
      })}
    </div>
  );
}
