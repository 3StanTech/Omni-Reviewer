import type { Metadata, Viewport } from "next";
import Script from "next/script";
import {
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Source_Serif_4,
  STIX_Two_Math,
} from "next/font/google";

import { KirbyDefs } from "@/components/kirby-companion";
import { LookProvider } from "@/components/look-provider";
import { TourProvider } from "@/components/tour/tour-provider";
import { LOOK_THEME_COLOR } from "@/lib/look-theme";

import "./globals.css";

const uiSans = IBM_Plex_Sans({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const readingSerif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

// MathML needs a math font; many systems (and the PDF renderer) have none. Loaded only where math shows.
const mathFont = STIX_Two_Math({
  variable: "--font-math",
  weight: "400",
  adjustFontFallback: false,
});

const uiMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

// Mirrors normalizeLook and applyLookToDocument (components/look-provider.tsx) before first paint.
const lookBootstrap = `(function(){try{var c=${JSON.stringify(LOOK_THEME_COLOR)};var v=localStorage.getItem("omni-look");var look=v==="dreamland"||v==="day"||v==="night"?v:(v==="thea"||v==="remnote"?"day":"dreamland");var el=document.documentElement;el.setAttribute("data-look",look);el.classList.toggle("dark",look==="night");var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++)m[i].setAttribute("content",c[look]);}catch(e){}})();`;

export const metadata: Metadata = {
  title: "Omni-Reviewer",
  description: "Personal study packs with four durable study modes.",
  applicationName: "Omni-Reviewer",
  appleWebApp: {
    capable: true,
    title: "Reviewer",
    statusBarStyle: "default",
  },
};

// One unqualified theme-color: the browser bar follows the chosen mood, not the OS
// scheme. Server HTML carries the default Dream Land tone; lookBootstrap and
// applyLookToDocument rewrite it from LOOK_THEME_COLOR (lib/look-theme.ts).
export const viewport: Viewport = {
  themeColor: LOOK_THEME_COLOR.dreamland,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-look="dreamland"
      className={`${uiSans.variable} ${readingSerif.variable} ${uiMono.variable} ${mathFont.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col font-sans">
        <KirbyDefs />
        <Script id="omni-look" strategy="beforeInteractive">
          {lookBootstrap}
        </Script>
        <LookProvider>
          <TourProvider>{children}</TourProvider>
        </LookProvider>
      </body>
    </html>
  );
}
