import { claimSentences, parseCitations, stripCitations, UNSOURCED_TOKEN } from "@/lib/citations";
import { LEXICAL_SUPPORT_THRESHOLD, lexicalSupport } from "@/lib/grounding";

/**
 * An uncited Test Me explanation borrows the first citation of the Locked In
 * claim it restates most closely, so the answer review still links to a source.
 * Deterministic and never invented: only a cited, sourced Locked In claim whose
 * wording supports the explanation at the grounding threshold can donate, and
 * the earliest wins a tie.
 */
export function withFallbackCitations<T extends { explanation: string; answer: string }>(
  items: T[],
  lockedInMarkdown: string,
): T[] {
  const candidates = claimSentences(lockedInMarkdown)
    .filter((claim) => !claim.text.includes(UNSOURCED_TOKEN))
    .flatMap((claim) => {
      const [first] = parseCitations(claim.text);
      return first ? [{ text: stripCitations(claim.text), raw: first.raw }] : [];
    });
  if (candidates.length === 0) return items;

  return items.map((item) => {
    if (parseCitations(item.explanation).length > 0) return item;
    const explanation = stripCitations(item.explanation);
    let best: { score: number; raw: string } | null = null;
    for (const candidate of candidates) {
      const score = lexicalSupport(explanation, candidate.text);
      if (!best || score > best.score) best = { score, raw: candidate.raw };
    }
    if (!best || best.score < LEXICAL_SUPPORT_THRESHOLD) return item;
    return { ...item, explanation: `${item.explanation.trimEnd()} ${best.raw}` };
  });
}
