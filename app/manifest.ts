import type { MetadataRoute } from "next";

// Night look `--background: oklch(0.14 0.025 250)` in app/globals.css.
const NIGHT_BACKGROUND = "#030a13";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Omni-Reviewer",
    short_name: "Reviewer",
    description: "Personal study packs with four durable study modes.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    categories: ["education"],
    background_color: NIGHT_BACKGROUND,
    theme_color: NIGHT_BACKGROUND,
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
