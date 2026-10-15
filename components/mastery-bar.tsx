import { WarpStar } from "@/components/kirby-art";
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
      <span aria-hidden className="relative w-16 shrink-0">
        <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full",
              clamped < MASTERY_WEAK_THRESHOLD ? "bg-warning" : "bg-primary",
            )}
            style={{ width: `${percent}%` }}
          />
        </span>
        {/* Dream Land: a small Warp Star at the head of the fill. */}
        <span
          className="pointer-events-none absolute top-1/2 hidden w-3 -translate-x-1/2 -translate-y-1/2 print-hide dreamland:block"
          style={{ left: `${percent}%` }}
        >
          <WarpStar trail={false} />
        </span>
      </span>
      {label ? <span aria-hidden>{percent}%</span> : null}
    </span>
  );
}
