import type { Metadata } from "next";
import Script from "next/script";
import {
  DM_Sans,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Source_Sans_3,
  Source_Serif_4,
} from "next/font/google";

import { LookProvider } from "@/components/look-provider";

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

const theaSans = DM_Sans({
  variable: "--font-thea",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const remnoteSans = Source_Sans_3({
  variable: "--font-remnote",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const uiMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const lookBootstrap = `(function(){try{var v=localStorage.getItem("omni-look");var look=v==="day"||v==="night"||v==="thea"||v==="remnote"?v:"night";var el=document.documentElement;el.setAttribute("data-look",look);el.classList.toggle("dark",look==="night");}catch(e){}})();`;

export const metadata: Metadata = {
  title: "Omni-Reviewer",
  description: "Personal study packs with four durable study modes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-look="night"
      className={`dark ${uiSans.variable} ${readingSerif.variable} ${theaSans.variable} ${remnoteSans.variable} ${uiMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col font-sans">
        <Script id="omni-look" strategy="beforeInteractive">
          {lookBootstrap}
        </Script>
        <LookProvider>{children}</LookProvider>
      </body>
    </html>
  );
}
