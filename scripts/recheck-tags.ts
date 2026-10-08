/**
 * Re-check every saved unsourced tag without a model call, and optionally save
 * the documents whose tags or reasons change.
 *
 * Usage:
 *   npx tsx --env-file=.env.local --conditions=react-server scripts/recheck-tags.ts [--reviewer <id>] [--apply]
 *
 * Reads the Locked In and Summary of every pack not being deleted whose text
 * carries a tag (or of one pack with --reviewer), loads that pack's grounding
 * sources as Check again does, and re-checks with the verifier skipped: tagged
 * claims that now pass overlap and the term guard lose their tags, tagged
 * lexical misses keep theirs, and no other claim is tagged. Prints, per
 * document, tags before and after, the sentences that would clear (first 100
 * characters) and the terms still flagged.
 * Dry run by default: no writes. --apply saves each changed document through
 * updateStudyView with its read revision and skips one that changed since.
 * No model calls; no other writes.
 */

import { and, eq, inArray, isNull, like } from "drizzle-orm";

import { readStudyDocumentMeta, UNSOURCED_TOKEN } from "@/lib/citations";
import { db } from "@/lib/db";
import { getViewForReviewer, loadGroundingSources, updateStudyView } from "@/lib/queries";
import { recheckDocument } from "@/lib/recheck-tags";
import { reviewers, topics, views } from "@/lib/schema";

type Kind = "locked_in" | "summary";

function usage(): never {
  console.error("Usage: npx tsx --env-file=.env.local --conditions=react-server scripts/recheck-tags.ts [--reviewer <id>] [--apply]");
  process.exit(1);
}

function parseArgs(argv: string[]): { reviewerId: string | null; apply: boolean } {
  let reviewerId: string | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--reviewer" && argv[i + 1] && !argv[i + 1].startsWith("--")) reviewerId = argv[++i];
    else usage();
  }
  return { reviewerId, apply };
}

/** Tagged Locked In and Summary documents with their owners, packs being deleted left out. */
async function taggedDocuments(reviewerId: string | null) {
  const conditions = [
    inArray(views.kind, ["locked_in", "summary"]),
    like(views.content, `%${UNSOURCED_TOKEN}%`),
    isNull(reviewers.deletingAt),
    isNull(topics.deletingAt),
  ];
  if (reviewerId) conditions.push(eq(views.reviewerId, reviewerId));
  return db
    .select({ reviewerId: views.reviewerId, kind: views.kind, userId: topics.userId, name: reviewers.name })
    .from(views)
    .innerJoin(reviewers, eq(reviewers.id, views.reviewerId))
    .innerJoin(topics, eq(topics.id, reviewers.topicId))
    .where(and(...conditions))
    .orderBy(views.reviewerId, views.kind);
}

async function main() {
  const { reviewerId, apply } = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const documents = await taggedDocuments(reviewerId);
  const rows: Array<{ pack: string; kind: Kind; before: number; after: number; cleared: number; result: string }> = [];
  const termTotals: Record<string, number> = {};
  let applied = 0;
  let skipped = 0;

  for (const document of documents) {
    const kind = document.kind as Kind;
    const view = await getViewForReviewer(document.reviewerId, document.userId, kind);
    if (!view?.content?.trim()) continue;
    const meta = readStudyDocumentMeta(view.contentJson);
    const sources = await loadGroundingSources(document.reviewerId, meta?.citationSources ?? []);
    const label = `${document.name} (${document.reviewerId}) ${kind}`;
    if (sources.length === 0) {
      console.log(`\n${label}: no sources to check against, skipped`);
      continue;
    }

    const result = await recheckDocument({ markdown: view.content, sources, previous: meta?.grounding ?? null });
    console.log(`\n${label}: tags ${result.tagsBefore} -> ${result.tagsAfter}`);
    for (const sentence of result.cleared) console.log(`  cleared: ${sentence}`);
    const terms = Object.entries(result.stillFlagged).sort((a, b) => b[1] - a[1]);
    if (terms.length > 0) console.log(`  still flagged: ${terms.map(([term, count]) => `${term} (${count})`).join(", ")}`);
    for (const [term, count] of terms) termTotals[term] = (termTotals[term] ?? 0) + count;

    let outcome = result.changed ? "would change" : "unchanged";
    if (apply && result.changed) {
      const row = await updateStudyView({
        reviewerId: document.reviewerId,
        userId: document.userId,
        kind,
        expectedRevision: view.revision,
        content: result.markdown,
        grounding: result.report,
      });
      if (!row || "stale" in row) {
        skipped++;
        outcome = "skipped (changed)";
      } else {
        applied++;
        outcome = "applied";
      }
    }
    rows.push({
      pack: document.name.slice(0, 40),
      kind,
      before: result.tagsBefore,
      after: result.tagsAfter,
      cleared: result.cleared.length,
      result: outcome,
    });
  }

  console.log("");
  if (rows.length > 0) console.table(rows);
  else console.log("No tagged documents found.");
  const totals = Object.entries(termTotals).sort((a, b) => b[1] - a[1]);
  if (totals.length > 0) console.log(`Still flagged terms: ${totals.map(([term, count]) => `${term} (${count})`).join(", ")}`);
  if (apply) console.log(`applied ${applied} documents, skipped ${skipped} (changed)`);
  else console.log("Dry run: nothing saved. Re-run with --apply to save.");
}

main().catch((error: unknown) => {
  const url = process.env.DATABASE_URL;
  let message = error instanceof Error ? error.message : String(error);
  if (url) message = message.split(url).join("<DATABASE_URL>");
  console.error(`Tag re-check failed: ${message}`);
  process.exit(1);
});
