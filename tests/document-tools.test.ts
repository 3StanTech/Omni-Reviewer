import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "@/components/study-markdown";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const textOf = (html: string) => html.replace(/<[^>]+>/g, "");

describe("document title prefix", () => {
  it("wraps the Locked In prefix of the first H1 without changing its text", () => {
    const source = "# Locked In: Cell Biology\n\nBody text.\n\n# Locked In: Again";
    const plain = renderToStaticMarkup(createElement(MarkdownBody, { source }));
    const hidden = renderToStaticMarkup(createElement(MarkdownBody, { source, hideModePrefix: true }));
    expect(hidden).toContain('<span class="study-mode-prefix">Locked In: </span>Cell Biology');
    // Only the first H1.
    expect(hidden.match(/study-mode-prefix/g)).toHaveLength(1);
    // Text and heading ids are unchanged, so annotation offsets still match.
    expect(textOf(hidden)).toBe(textOf(plain));
    expect([...hidden.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])).toEqual(
      [...plain.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]),
    );
  });

  it("handles Summary and leaves other titles and callers alone", () => {
    const summary = renderToStaticMarkup(createElement(MarkdownBody, { source: "# Summary: Genetics", hideModePrefix: true }));
    expect(summary).toContain('<span class="study-mode-prefix">Summary: </span>Genetics');
    const other = renderToStaticMarkup(createElement(MarkdownBody, { source: "# Genetics: Summary", hideModePrefix: true }));
    expect(other).not.toContain("study-mode-prefix");
    const shared = renderToStaticMarkup(createElement(MarkdownBody, { source: "# Locked In: Cells" }));
    expect(shared).not.toContain("study-mode-prefix");
  });

  it("is passed only by the study document and hidden on screen, shown in print", () => {
    expect(read("components/study-document.tsx")).toContain("annotations={activeAnnotations} hideModePrefix />");
    for (const file of ["components/packet-document.tsx", "components/ask-message.tsx", "components/study-side-panel.tsx"]) {
      expect(read(file), file).not.toContain("hideModePrefix");
    }
    const css = read("app/globals.css");
    const screen = css.indexOf(".study-mode-prefix {\n    display: none;");
    const print = css.indexOf("@media print {");
    expect(screen).toBeGreaterThan(-1);
    expect(screen).toBeLessThan(print);
    const printBlock = css.slice(print, css.indexOf("\n}\n", print));
    expect(printBlock).toContain(".study-mode-prefix {\n    display: inline;");
  });
});

describe("document tools in the strip", () => {
  const document = read("components/study-document.tsx");

  it("renders the chip, Contents, Notes, Edit and Download through ModeActions", () => {
    const start = document.indexOf("<ModeActions>");
    const actions = document.slice(start, document.indexOf("</ModeActions>", start));
    expect(start).toBeGreaterThan(-1);
    expect(actions).toContain("<SealCheck");
    expect(actions).toContain("sourced");
    expect(actions).toContain("title={claimsLabel}");
    expect(actions).toContain("<StudySidePanel");
    expect(actions).toContain("openRequest={panelRequest}");
    expect(actions).toContain("<PencilSimple");
    expect(actions).toContain('<span className="max-sm:sr-only">Edit</span>');
    expect(actions).toContain('variant="ghost"');
    expect(actions).toContain("<StudyExport");
    expect(actions).toContain('"Cancel edit"');
    expect(actions).toContain('"Save changes"');
  });

  it("registers Check again, Open slides, Pin and Earlier version as More items", () => {
    expect(document).toContain("useModeMenuItems(`doc:${kind}`, menuItems);");
    for (const id of ["check-again", "open-slides", "pin", "earlier"]) {
      expect(document).toContain(`id: "${id}"`);
    }
    expect(document).toContain('label: "Open slides"');
    expect(document).toContain("openSource({ source: firstCitation.source, page: firstCitation.pageStart })");
    expect(document).toContain('"Pinned and protected from silent overwrite" : "Protect from silent overwrite"');
    expect(document).toContain("onSelect: () => void togglePinned()");
    expect(document).toContain('setPanelRequest({ kind: "earlier", nonce: Date.now() })');
  });

  it("removes the old toolbar rows and hint line", () => {
    expect(document).not.toContain("Select text to highlight or add a note.");
    expect(document).not.toContain('<span className="text-xs text-warning">Pinned and protected');
    expect(document).not.toContain("Presentation");
    expect(document).not.toContain('variant="outline" size="sm" onClick={() => void togglePinned()}');
  });
});

describe("side panel and export trigger", () => {
  const panel = read("components/study-side-panel.tsx");

  it("opens on request, closes on outside pointer down, and keeps compact ghost triggers", () => {
    expect(panel).toContain("openRequest?: PanelOpenRequest | null;");
    expect(panel).toContain("openRequest.nonce !== seenRequest");
    expect(panel).toContain('document.addEventListener("pointerdown", onPointerDown);');
    expect(panel).toContain("rootRef.current?.contains(target)");
    expect(panel).toContain('buttonVariants({ variant: "ghost", size: "sm" })');
    expect(panel).toContain("<ListBullets");
    expect(panel).toContain("<NotePencil");
    expect(panel).toContain("study-side-panel relative");
    // Earlier version opens from More, not from a strip trigger.
    expect(panel).not.toContain('toggle("earlier"');
    expect(panel).toContain("No highlights or notes yet. Select text in the document to highlight or add a note.");
  });

  it("makes the drawer a popover on desktop and keeps the phone sheet", () => {
    const css = read("app/globals.css");
    const desktop = css.slice(css.indexOf("@media (min-width: 641px) {"));
    const rule = desktop.slice(0, desktop.indexOf("}\n  }"));
    expect(rule).toContain(".study-side-panel-drawer");
    expect(rule).toContain("position: absolute;");
    expect(rule).toContain("top: calc(100% + 0.5rem);");
    expect(rule).toContain("right: 0;");
    expect(rule).toContain("width: min(24rem, calc(100vw - 2rem));");
    expect(rule).toContain("max-height: min(70vh, 36rem);");
    expect(rule).toContain("background: var(--popover);");
    const phone = css.slice(css.indexOf("@media (max-width: 640px) {"));
    expect(phone).toContain("position: fixed;");
  });

  it("uses a ghost Download trigger whose label hides on phones", () => {
    const exportMenu = read("components/study-export.tsx");
    expect(exportMenu).toContain('variant="ghost"');
    expect(exportMenu).not.toContain('variant="outline"');
    expect(exportMenu).toContain("<DownloadSimple");
    expect(exportMenu).toContain('<span className="max-sm:sr-only">{preparing ? "Preparing PDF" : "Download"}</span>');
    expect(exportMenu).toContain("min-h-11");
  });
});
