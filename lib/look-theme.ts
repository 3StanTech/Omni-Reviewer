import type { LookId } from "@/components/look-provider";

/**
 * Browser-bar colour per mood: each look's `--page` tone (app/globals.css).
 * Lives outside the "use client" provider so the server root layout can
 * serialize the same values into its early-load script.
 */
export const LOOK_THEME_COLOR: Record<LookId, string> = {
  dreamland: "#fff6ec",
  day: "#ffffff",
  night: "#030a13",
};
