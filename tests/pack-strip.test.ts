import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GenerationControls } from "@/components/generation-controls";
import { PACK_READY_MS, PackReadyNotice } from "@/components/pack-ready-notice";
import type { GenerationState } from "@/lib/use-generation";

const root = path.resolve(__dirname, "..");
const EM_DASH = "—";

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

const idleState: GenerationState = {
  job: null,
  jobId: null,
  status: "idle",
  step: null,
  views: null,
  error: null,
  busy: false,
  dismissed: false,
};

describe("study strip", () => {
  const tabs = read("components/view-tabs.tsx");

  it("is one sticky strip that does not clip menus; the tab list scrolls instead", () => {
    const strip = tabs.match(/className="print-hide sticky top-14[^"]*"/)?.[0] ?? "";
    expect(strip).toContain("flex flex-wrap items-end");
    expect(strip).not.toContain("overflow-x-auto");
    // backdrop-filter, filter, transform or will-change would make the strip the containing block
    // for the phone sheets (position: fixed) the mode tools render into the slot.
    for (const trap of ["backdrop-blur", "backdrop-", "blur", "transform", "translate", "filter", "will-change"]) {
      expect(strip, trap).not.toContain(trap);
    }
    const slot = tabs.match(/<div ref=\{slotRef\}[^>]*className="[^"]*"/)?.[0] ?? "";
    for (const trap of ["backdrop-", "blur", "transform", "translate", "filter", "will-change"]) {
      expect(slot, trap).not.toContain(trap);
    }
    expect(tabs).toContain('"min-w-0 flex-1 overflow-x-auto border-b-0"');
    expect(tabs).toContain('aria-label="Study modes"');
  });

  it("keeps the Focus toggle visible in Focus mode while tabs, tools and More hide", () => {
    const wrapper = tabs.match(/<div[^>]*className="print-hide sticky top-14[^"]*"[^>]*>/)?.[0] ?? "";
    expect(wrapper).not.toBe("");
    expect(wrapper).not.toContain("data-focus-hide");
    expect(tabs).toMatch(/<TabsList\s+data-focus-hide/);
    expect(tabs).toMatch(/<div ref=\{slotRef\} data-focus-hide /);
    const trigger = tabs.slice(tabs.indexOf("<DropdownMenuTrigger"), tabs.indexOf("</DropdownMenuTrigger>"));
    expect(trigger).toContain("data-focus-hide");
    // Every element still open when <FocusToggle /> renders must lack data-focus-hide.
    const before = tabs.slice(tabs.indexOf("<Tabs\n"), tabs.indexOf("<FocusToggle />"));
    const open: string[] = [];
    for (const match of before.matchAll(/<(\/?)(div|section|Tabs|TabsList)\b([^>]*?)(\/?)>/g)) {
      const [, closing, , attrs, selfClosing] = match;
      if (selfClosing) continue;
      if (closing) open.pop();
      else open.push(attrs);
    }
    expect(open.length).toBeGreaterThan(0);
    for (const attrs of open) expect(attrs).not.toContain("data-focus-hide");
  });

  it("hosts the mode toolbar: provider, a relative slot, Focus and More", () => {
    expect(tabs).toContain("<ModeToolbarProvider>");
    expect(tabs).toContain("useModeToolbarSlotRef()");
    expect(tabs).toMatch(/<div ref=\{slotRef\} data-focus-hide className="relative /);
    const strip = tabs.slice(tabs.indexOf("sticky top-14"), tabs.indexOf("<TabsContent"));
    expect(strip).toContain("<ModeToolsSlot />");
    expect(strip).toContain("<FocusToggle />");
    expect(strip).toContain("<MoreMenu");
    // The old Focus row and Redo row are gone.
    expect(tabs).not.toContain("flex justify-end empty:hidden");
    expect(tabs.match(/<FocusToggle \/>/g)?.length).toBe(1);
  });

  it("puts registered mode items, Redo and pack items in one ghost More menu", () => {
    expect(tabs).toContain("useModeMenuItemsValue()");
    expect(tabs).toContain("packMenuItems?: ModeMenuItem[];");
    expect(tabs).toContain('aria-label="More actions"');
    expect(tabs).toContain("<DotsThreeVertical");
    const trigger = tabs.slice(tabs.indexOf("<DropdownMenuTrigger"), tabs.indexOf("</DropdownMenuTrigger>"));
    expect(trigger).toContain('variant="ghost"');
    expect(trigger).toContain("pointer-coarse:size-11");
    expect(tabs).toContain("pointer-coarse:min-h-11");
    expect(tabs).not.toContain('variant="outline"\n              disabled={redoDisabled}');
  });

  it("keeps Redo's label, description, requests left and confirm flow", () => {
    expect(tabs).toContain("`Redo ${copy.label}`");
    expect(tabs).toContain("hint: blockReason ?? copy.description");
    expect(tabs).toContain("left today.");
    expect(tabs).toContain("LOW_QUOTA_THRESHOLD");
    expect(tabs).toContain("onSelect: requestRedo");
    expect(tabs).toContain("showRedo");
    expect(tabs).toContain("setConfirmOpen(true)");
    expect(tabs).toContain("onRedoRequest && !onRedoRequest(tab, true)");
    expect(tabs).toContain("{copy.confirmTitle}");
  });

  it("keeps the study end sentinel right after the mode content", () => {
    const after = tabs.slice(tabs.indexOf("</TabsContent>"));
    expect(after.indexOf("<div data-study-end aria-hidden")).toBeGreaterThan(0);
    expect(after.indexOf("<div data-study-end aria-hidden")).toBeLessThan(after.indexOf("<Dialog"));
  });
});

describe("pack workspace", () => {
  const workspace = read("components/reviewer-workspace.tsx");

  it("shows exam countdown and Generated stamp on one meta line", () => {
    expect(workspace).toContain("`Generated ${generatedStamp}`");
    expect(workspace).toContain('"Not generated yet"');
    expect(workspace).toContain('headerMeta.join(" \\u00b7 ")');
    expect(workspace).toContain("isClient ? examCountdown : null");
  });

  it("drops the top-right Sources toggle and the details disclosure", () => {
    expect(workspace).not.toContain("<details");
    expect(workspace).not.toContain("aria-controls=\"sources-panel\"");
    expect(workspace).not.toContain("setSourcesUserOpen");
    expect(workspace).not.toContain("Last generated");
  });

  it("opens Exam date and Sources as dialogs from the pack More items", () => {
    expect(workspace).toContain("packMenuItems={packMenuItems}");
    expect(workspace).toContain('id: "sources"');
    expect(workspace).toContain("`Sources (${sources.length})`");
    expect(workspace).toContain('id: "exam-date"');
    expect(workspace).toContain("`Exam date: ${currentExamDate}`");
    expect(workspace).toContain('"Set exam date"');
    expect(workspace).toContain("<DialogTitle>Exam date</DialogTitle>");
    expect(workspace).toContain("Cards will be scheduled no later than this date.");
    expect(workspace).toContain('void saveExamDate("")');
    expect(workspace).toContain('className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"');
    // The panel is always expanded inside the dialog; reading stays hosted in the workspace.
    expect(workspace).toMatch(/<SourcePanel[^>]*\n\s*expanded\n/);
    expect(workspace).toContain("useSourceVision({ reviewerId, sources })");
  });

  it("shows the generation section above the study only while it has work, else a self-clearing ready line", () => {
    expect(workspace).toContain('className="print-hide space-y-3" aria-labelledby="generate-heading"');
    expect(workspace).toContain("<PackReadyNotice label={readyLabel} onDone={generation.dismiss} />");
    expect(workspace).toContain("!hasCompleteViews || jobVisible");
    expect(workspace).toContain('["queued", "running", "failed", "partial"]');
    const withViews = workspace.slice(workspace.indexOf("{hasViews ? (\n        <>"));
    expect(withViews.indexOf("{generationNotice}")).toBeLessThan(withViews.indexOf("{studySection}"));
    expect(withViews.slice(0, withViews.indexOf(") : ("))).not.toContain("{sourcePanel}");
    expect(workspace).toContain("Generate missing fills study modes that are not generated yet.");
  });

  it("keeps Study modes as a screen-reader heading and Scroll jump mounted", () => {
    expect(workspace).toMatch(/<h2 id="views-heading" className="sr-only">\s*Study modes/);
    expect(workspace).toContain('aria-labelledby="views-heading"');
    expect(workspace).toContain("<ScrollJump />");
  });
});

describe("generation controls", () => {
  const base = {
    state: idleState,
    hasReadySource: true,
    sourcesAreMediaOnly: false,
    onGenerate: () => undefined,
    onResume: () => undefined,
  };

  it("never says All generated", () => {
    expect(read("components/generation-controls.tsx")).not.toContain("All generated");
    const complete = renderToStaticMarkup(createElement(GenerationControls, { ...base, hasViews: true, hasCompleteViews: true }));
    expect(complete).not.toContain("All generated");
  });

  it("labels Generate, Generate missing and keeps the quota line", () => {
    const first = renderToStaticMarkup(
      createElement(GenerationControls, { ...base, hasViews: false, hasCompleteViews: false, quota: { remaining: 40, limit: 50 } }),
    );
    expect(first).toContain("Generate");
    expect(first).toContain("40 of 50 free requests left today");
    const missing = renderToStaticMarkup(createElement(GenerationControls, { ...base, hasViews: true, hasCompleteViews: false }));
    expect(missing).toContain("Generate missing");
  });
});

describe("pack ready notice", () => {
  it("renders a status line with the label", () => {
    const html = renderToStaticMarkup(createElement(PackReadyNotice, { onDone: () => undefined }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Pack ready");
    expect(html).toContain("print-hide");
    const redo = renderToStaticMarkup(createElement(PackReadyNotice, { label: "Summary ready", onDone: () => undefined }));
    expect(redo).toContain("Summary ready");
  });

  it("clears itself after 6 seconds with the latest handler", () => {
    expect(PACK_READY_MS).toBe(6000);
    const source = read("components/pack-ready-notice.tsx");
    expect(source).toContain("window.setTimeout(() => onDoneRef.current(), PACK_READY_MS)");
    expect(source).toContain("window.clearTimeout(timer)");
  });
});

describe("copy", () => {
  it("has no em dashes in the strip, workspace, notice or controls", () => {
    for (const file of [
      "components/view-tabs.tsx",
      "components/reviewer-workspace.tsx",
      "components/pack-ready-notice.tsx",
      "components/generation-controls.tsx",
    ]) {
      expect(read(file), file).not.toContain(EM_DASH);
    }
  });
});
