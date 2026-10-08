/**
 * No-model re-check of a saved study document's unsourced tags, the pure core
 * of `scripts/recheck-tags.ts`. It is Check again without the verifier: tagged
 * claims that now pass overlap and the term guard lose their tags, tagged
 * lexical misses keep theirs, and no untagged claim is newly tagged.
 */

import { UNSOURCED_TOKEN } from "@/lib/citations";
import {
  groundDocument,
  mergeRecheckReport,
  taggedClaims,
  type GroundingReport,
  type GroundingSource,
} from "@/lib/grounding";

const CLEARED_PREVIEW_CHARS = 100;

export type RecheckDocumentResult = {
  markdown: string;
  report: GroundingReport;
  tagsBefore: number;
  tagsAfter: number;
  /** First 100 characters of each sentence whose tag would clear. */
  cleared: string[];
  /** Each recorded missing term of the tags that remain, with how many tags name it. */
  stillFlagged: Record<string, number>;
  /** Whether saving would change anything: tags or recorded reasons. */
  changed: boolean;
};

function countTags(markdown: string): number {
  return markdown.split(UNSOURCED_TOKEN).length - 1;
}

function sameTermFlags(a: GroundingReport["termFlags"], b: GroundingReport["termFlags"]): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

export async function recheckDocument({
  markdown,
  sources,
  previous,
}: {
  markdown: string;
  sources: GroundingSource[];
  previous: GroundingReport | null;
}): Promise<RecheckDocumentResult> {
  // No `verify` is passed and skipVerifier is set: this path can never reach a model.
  const pass = await groundDocument({
    markdown,
    sources,
    skipVerifier: true,
    recheck: {
      uncheckedKeys: previous?.uncheckedKeys,
      legacyUnchecked: !previous?.uncheckedKeys && (previous?.unchecked ?? 0) > 0,
      ...(previous?.termFlags ? { termFlags: previous.termFlags } : {}),
    },
  });
  const report = mergeRecheckReport(previous, pass.report, { noModel: true });

  // Cleared: tagged before, not after, matched by claim key (a key may repeat).
  const remaining = new Map<string, number>();
  const after = taggedClaims(pass.markdown);
  for (const { key } of after) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  const cleared: string[] = [];
  for (const { key, sentence } of taggedClaims(markdown)) {
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else cleared.push(sentence.slice(0, CLEARED_PREVIEW_CHARS));
  }

  const stillFlagged: Record<string, number> = {};
  for (const { key } of after) {
    for (const term of report.termFlags?.[key] ?? []) stillFlagged[term] = (stillFlagged[term] ?? 0) + 1;
  }

  return {
    markdown: pass.markdown,
    report,
    tagsBefore: countTags(markdown),
    tagsAfter: countTags(pass.markdown),
    cleared,
    stillFlagged,
    changed: pass.markdown !== markdown || !sameTermFlags(previous?.termFlags, report.termFlags),
  };
}
