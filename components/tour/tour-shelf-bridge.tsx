"use client";

import { useEffect, useRef } from "react";

import { useTour } from "@/components/tour/tour-provider";
import { isPhoneWidth } from "@/lib/tour-layout";

/**
 * Hands the shelf to Kirby's tour: the replay opens it for the topics stop and restores it after,
 * and on phones the first-visit tour closes the drawer once the topic exists so New pack shows.
 * Rendered beside the shelf toggle, inside the shelf's provider.
 */
export function TourShelfBridge({
  shelfOpen,
  setShelfOpen,
}: {
  shelfOpen: boolean;
  setShelfOpen: (open: boolean) => void;
}) {
  const tour = useTour();
  const bindShelf = tour?.bindShelf;
  const openRef = useRef(shelfOpen);
  useEffect(() => {
    openRef.current = shelfOpen;
  });

  useEffect(() => {
    if (!bindShelf) return;
    bindShelf({ isOpen: () => openRef.current, setOpen: setShelfOpen });
    return () => bindShelf(null);
  }, [bindShelf, setShelfOpen]);

  const firstVisitPack = tour?.step === "pack" && !tour.replay;
  useEffect(() => {
    if (firstVisitPack && shelfOpen && isPhoneWidth()) setShelfOpen(false);
  }, [firstVisitPack, shelfOpen, setShelfOpen]);

  return null;
}
