import { MASTERY_WEAK_THRESHOLD } from "@/lib/mastery";
import { cn } from "@/lib/utils";

/** A 64 by 6 mastery bar. Renders nothing until a section or pack has a score. */
export function MasteryBar({ score, label = false }: { score: number | null; label?: boolean }) {
  if (score === null) return null;
  const clamped = Math.min(1, Math.max(0, score));
  const percent = Math.round(clamped * 100);
  return (
    <span
      role="img"
      aria-label={`Mastery ${percent} percent`}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span aria-hidden className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            clamped < MASTERY_WEAK_THRESHOLD ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
      {label ? <span aria-hidden>{percent}%</span> : null}
    </span>
  );
}
