import "server-only";

import chromium from "@sparticuz/chromium";
import puppeteer, { type CookieData } from "puppeteer-core";

chromium.setGraphicsMode = false;

const LOAD_TIMEOUT_MS = 30_000;
const CONTENT_SELECTOR = '.prose-study:not([role="status"]), .print-document';

export class PdfSignedOutError extends Error {}

type RenderPdfInput = {
  /** Same-origin page to render; the requester's cookies are replayed so it renders as them. */
  url: URL;
  cookieHeader: string | null;
  /** Values for body data attributes the print CSS reads (data-export-citations and so on). */
  bodyData?: Record<string, string>;
};

function parseCookies(header: string | null, url: URL): CookieData[] {
  if (!header) return [];
  return header.split(";").flatMap((pair) => {
    const index = pair.indexOf("=");
    if (index <= 0) return [];
    return [{
      name: pair.slice(0, index).trim(),
      value: pair.slice(index + 1).trim(),
      domain: url.hostname,
      path: "/",
      secure: url.protocol === "https:",
      httpOnly: true,
    }];
  });
}

/** Render a page of this app to an A4 PDF with its print CSS, using headless Chrome. */
export async function renderPdf({ url, cookieHeader, bodyData }: RenderPdfInput): Promise<Uint8Array> {
  // CHROME_EXECUTABLE_PATH points at a local Chrome; the bundled Chromium is Linux-only.
  const localChrome = process.env.CHROME_EXECUTABLE_PATH;
  const browser = await puppeteer.launch({
    args: localChrome ? [] : await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
    executablePath: localChrome ?? (await chromium.executablePath()),
    headless: "shell",
    defaultViewport: { width: 1200, height: 1600 },
  });
  try {
    await browser.setCookie(...parseCookies(cookieHeader, url));
    const page = await browser.newPage();
    // Print the day look; with no saved look the app starts in night.
    await page.evaluateOnNewDocument(() => localStorage.setItem("omni-look", "day"));
    await page.goto(url.toString(), { waitUntil: "networkidle2", timeout: LOAD_TIMEOUT_MS });
    if (new URL(page.url()).pathname.startsWith("/login")) throw new PdfSignedOutError();
    await page.waitForSelector(CONTENT_SELECTOR, { timeout: LOAD_TIMEOUT_MS });
    await page.emulateMediaType("print");
    await page.evaluate(async (data) => {
      Object.assign(document.body.dataset, data);
      await document.fonts.ready;
    }, bodyData ?? {});
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}
