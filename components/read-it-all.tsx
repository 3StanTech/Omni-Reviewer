"use client";

import { useEffect, useState, type RefObject } from "react";

import { KirbyCompanion } from "@/components/kirby-companion";
import { kirbyHat } from "@/lib/kirby-hat";

/**
 * "You read it all!" after the document end in Locked In and Summary. It appears once the
 * `data-study-end` marker scrolls into view after the reader has scrolled (a page that
 * opens already at its end does not count), then stays for that view during this page
 * visit. `reached` and `onReached` live in the parent so a tab switch keeps it. Kirby
 * dances only on the visit's first arrival (Dream Land only).
 */
export function ReadItAll({
  endRef,
  reached,
  onReached,
  reviewerId,
}: {
  endRef: RefObject<HTMLDivElement | null>;
  reached: boolean;
  onReached: () => void;
  reviewerId: string;
}) {
  const [arrivedAt, setArrivedAt] = useState<number | null>(null);

  useEffect(() => {
    const marker = endRef.current;
    if (reached || !marker || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || window.scrollY <= 0) return;
      observer.disconnect();
      setArrivedAt(Date.now());
      onReached();
    });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [endRef, onReached, reached]);

  // The status region stays mounted so the line is announced when it appears.
  return (
    <div role="status" className="print-hide">
      {reached ? (
        <div className="flex items-center justify-center gap-2 py-2 text-sm font-medium text-foreground">
          <KirbyCompanion
            size="xs"
            hat={kirbyHat(reviewerId)}
            reaction={arrivedAt !== null ? { outcome: "dance", key: arrivedAt } : null}
            className="shrink-0"
          />
          <span>You read it all!</span>
        </div>
      ) : null}
    </div>
  );
}
