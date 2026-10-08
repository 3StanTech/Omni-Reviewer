import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { STUDY_HELP_LINES, StudyHelp } from "@/components/study-help";

const root = path.resolve(__dirname, "..");
const source = readFileSync(path.join(root, "components/study-help.tsx"), "utf8");

/** Each explainer line as plain text, bold leads included. */
const lines = STUDY_HELP_LINES.map((line) => line.map((part) => `${part.lead}${part.text}`).join(""));

describe("How cards come back", () => {
  it("uses the agreed copy exactly", () => {
    expect(lines).toEqual([
      "New: cards you have not studied yet. Up to 20 a day per pack, or spread out until the exam when an exam date is set.",
      "To review: cards you studied before whose return date has come.",
      "Again brings a card back tomorrow. Good spaces it out: about 3 days, then 2 weeks, then 2 months, then longer. No card comes back after your exam date.",
      "Weak section: under 60% correct across 3 or more answers from Test Me and Carded. See the plan suggests a re-test or a re-read.",
    ]);
    expect(STUDY_HELP_LINES.flat().map((part) => part.lead)).toEqual(["New", "To review", "Again", "Good", "Weak section"]);
  });

  it("has no em dashes and uses a Phosphor icon", () => {
    expect(source).not.toContain("\u2014");
    expect(source).toContain('import { Question } from "@phosphor-icons/react";');
  });

  it("renders a closed 44px trigger, labelled and icon-only below 640px", () => {
    const html = renderToStaticMarkup(createElement(StudyHelp));
    expect(html).toContain('aria-label="How cards come back"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("min-h-11");
    expect(html).toContain("max-sm:w-11");
    expect(html).toContain('<span class="max-sm:sr-only">How cards come back</span>');
    expect(html).not.toContain('role="dialog"');
  });

  it("opens as the Contents popover on desktop and sheet on phones, with a 44px Close", () => {
    expect(source).toContain('className="study-side-panel-backdrop"');
    expect(source).toContain("study-side-panel-drawer");
    expect(source).toContain('role="dialog"');
    expect(source).toContain("aria-modal={compactSheet}");
    expect(source).toContain('window.matchMedia("(max-width: 640px)")');
    expect(source).toContain('className="min-h-11 min-w-11');
  });

  it("closes on Escape and returns focus to the trigger", () => {
    expect(source).toContain('if (event.key !== "Escape") return;');
    expect(source).toContain("event.preventDefault();");
    expect(source).toContain("if (restoreFocus.current) triggerRef.current?.focus();");
  });

  it("hides the floating buttons while the phone sheet is open, and cleans up", () => {
    expect(source).toContain("if (!open || !compactSheet) return;");
    expect(source).toContain('root.dataset.studySheetOpen = "true";');
    expect(source).toContain("delete root.dataset.studySheetOpen;");
  });

  it("sits on the Today card and in Carded's header tools", () => {
    expect(readFileSync(path.join(root, "components/today-card.tsx"), "utf8")).toContain("<StudyHelp />");
    expect(readFileSync(path.join(root, "components/carded-view.tsx"), "utf8")).toContain("<StudyHelp />");
  });
});
