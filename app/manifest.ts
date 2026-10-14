import type { MetadataRoute } from "next";

// Dream Land (the default look) `--page: #fff6ec` in app/globals.css.
const DEFAULT_BACKGROUND = "#fff6ec";

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
    background_color: DEFAULT_BACKGROUND,
    theme_color: DEFAULT_BACKGROUND,
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
