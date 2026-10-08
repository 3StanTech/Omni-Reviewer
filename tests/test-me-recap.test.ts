import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const src = readFileSync(path.join(root, "components/test-me-view.tsx"), "utf8");
const recap = src.slice(src.indexOf("if (complete || !item)"), src.indexOf("const questionId = controlId(item.id"));

describe("Test Me recap", () => {
  it("shows the score through SittingRecap instead of an N of M line", () => {
    expect(recap).toContain("score={{ correct: score, total: sittingItems.length }}");
    expect(recap).not.toContain("correct`,");
    expect(recap).toContain("Studied for ${formatSittingDuration(finishedAt - openedAt)}");
  });

  it("breaks the sitting down by section from the answered items", () => {
    expect(src).toContain('import { formatSittingDuration, recapFocusSection, sectionBreakdown } from "@/lib/sitting-recap";');
    expect(recap).toContain("sectionBreakdown({");
    expect(recap).toContain("progress.answersByItemId[answered.id]");
    expect(recap).toContain("text: citedText(answered)");
    expect(recap).toContain("By section");
    expect(recap).toContain("{row.correct} of {row.total}");
    // The same cited text decides the focus section.
    expect(recap).toContain("missedTexts: missedItems.map(citedText)");
  });

  it("puts the reader's answer beside the correct one for each miss", () => {
    expect(recap).toContain("progress.answersByItemId[missed.id]?.selectedAnswer");
    expect(recap).toContain("Your answer:");
    expect(recap).toContain('"No answer"');
    expect(recap).toContain("Correct: <MarkdownBody source={missed.answer} inline />");
    expect(recap.indexOf("Your answer:")).toBeLessThan(recap.indexOf("Correct: <MarkdownBody"));
    expect(recap).toMatch(/<XCircle weight="fill"[^>]*aria-hidden \/>\s*<span[^>]*>\s*Your answer:/);
    expect(recap).toMatch(/<CheckCircle weight="fill"[^>]*aria-hidden \/>\s*<span[^>]*>\s*Correct:/);
  });

  it("keeps Retry missed, Start again, the saved note and the timed run", () => {
    expect(recap).toContain('mutateSession("retry_missed")');
    expect(recap).toContain('mutateSession("start_again")');
    expect(recap).toContain("Attempts and misses are saved.");
    expect(recap).toContain("{timedRunButton}");
    expect(recap).toContain("No misses this sitting.");
  });

  it("writes no answers from the recap and has no em dash", () => {
    expect(recap).not.toContain("/test-attempts");
    expect(src).not.toContain("\u2014");
  });
});
