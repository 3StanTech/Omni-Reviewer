import { GreenGreensHills } from "@/components/kirby-art";

/**
 * Green Greens: a decorative band of hills at the bottom of the desk page (Dream Land only).
 * It sits after all content, bleeds to the main column's edges and never takes pointer events.
 */
export function GreenGreens() {
  return (
    <div
      aria-hidden="true"
      className="print-hide pointer-events-none -mx-4 -mb-6 mt-auto hidden dreamland:block sm:-mx-6 sm:-mb-8"
    >
      <GreenGreensHills className="h-24 w-full max-sm:h-16" />
    </div>
  );
}
