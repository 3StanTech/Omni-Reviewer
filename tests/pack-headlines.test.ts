import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("redundant study headlines", () => {
  const carded = read("components/carded-view.tsx");
  const testMe = read("components/test-me-view.tsx");

  it("drops the Carded tagline but keeps the session and remaining lines", () => {
    expect(carded).not.toContain("Memorize. No choices.");
    expect(carded).toContain("<p>{sessionLabel}</p>");
    expect(carded).toContain("<p>Remaining: {remainingCopy}</p>");
  });

  it("keeps the Test Me heading for screen readers only", () => {
    expect(testMe).not.toContain("Exam sitting. Pick an answer.");
    const headings = testMe.match(
      /<h2 id="test-me-sitting-title" className="sr-only">\s*Test Me\s*<\/h2>/g,
    );
    expect(headings).toHaveLength(3);
    expect(testMe.match(/id="test-me-sitting-title"/g)).toHaveLength(3);
    expect(testMe.match(/aria-labelledby="test-me-sitting-title"/g)).toHaveLength(3);
    expect(testMe).toContain("Question {viewIndex + 1} of {sittingItems.length}");
  });
});

describe("pack row Review and Resume buttons", () => {
  const list = read("components/reviewer-list.tsx");

  it("imports the Phosphor icons", () => {
    expect(list).toMatch(/\bCards,\n/);
    expect(list).toMatch(/\bExam,\n/);
    expect(list).toContain('from "@phosphor-icons/react"');
  });

  it("keeps the aria-labels", () => {
    expect(list).toContain("aria-label={`Review due cards in ${reviewer.name}`}");
    expect(list).toContain("aria-label={`Resume Test Me in ${reviewer.name}`}");
  });

  it("shows a 44px bold icon below 640px and the word from 640px up", () => {
    expect(list.match(/className="max-sm:size-11 max-sm:px-0"/g)).toHaveLength(2);
    expect(list).toContain('<Cards aria-hidden weight="bold" className="sm:hidden" />');
    expect(list).toContain('<Exam aria-hidden weight="bold" className="sm:hidden" />');
    expect(list).toContain('<span className="max-sm:sr-only">Review</span>');
    expect(list).toContain('<span className="max-sm:sr-only">Resume</span>');
  });
});
