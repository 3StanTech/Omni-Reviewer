import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";

import type { AnnotationRecord } from "@/lib/annotations";
import { db } from "@/lib/db";
import { loadGenerationViews } from "@/lib/generation-jobs";
import { parseCardedItems } from "@/lib/learning";
import { getReviewer, getTopic } from "@/lib/queries";
import { cards } from "@/lib/schema";
import type { SerializedView } from "@/lib/serialize-view";

/**
 * Read-only loaders for the PDF exports. Rendering an export must never write:
 * no card backfill, no job or view changes, nothing a page visit would trigger.
 */

export type ExportCard = { id: string; front: string; back: string };

export type ExportData = {
  topicName: string;
  packName: string;
  lockedIn: SerializedView | null;
  summary: SerializedView | null;
  cards: ExportCard[];
};

/**
 * A study view with only the annotations an export draws. The first annotation
 * page holds every active annotation unbounded; only archived history pages,
 * and exports never show that.
 */
function withActiveAnnotations(view: SerializedView | null): SerializedView | null {
  if (!view) return null;
  const active: AnnotationRecord[] = (view.annotations ?? []).filter((annotation) => !annotation.archivedAt);
  return { ...view, annotations: active, annotationsNextCursor: null };
}

/**
 * Active cards, or for a pack whose cards were never saved, its Carded items
 * projected in memory. getCardsForReviewer would insert those rows instead.
 */
async function exportCards(reviewerId: string, carded: SerializedView | null): Promise<ExportCard[]> {
  const rows = await db
    .select({ id: cards.id, front: cards.front, back: cards.back })
    .from(cards)
    .where(and(eq(cards.reviewerId, reviewerId), isNull(cards.archivedAt)))
    .orderBy(asc(cards.dueAt), asc(cards.createdAt));
  if (rows.length > 0) return rows;
  const items = carded ? parseCardedItems(carded.contentJson, carded.content) : [];
  return items
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .map((item) => ({ id: item.id, front: item.front, back: item.back }));
}

/**
 * The caller's pack in this topic, ready to print, or null when the topic or
 * pack is not theirs, the pack lives in another topic, or it is being deleted.
 */
export async function loadExportData(args: {
  topicId: string;
  reviewerId: string;
  userId: string;
  include: { cards: boolean };
}): Promise<ExportData | null> {
  const { topicId, reviewerId, userId } = args;
  const [topic, reviewer] = await Promise.all([getTopic(topicId, userId), getReviewer(reviewerId, userId)]);
  if (!topic || !reviewer || reviewer.topicId !== topic.id || reviewer.deletingAt) return null;

  const views = await loadGenerationViews(reviewerId, { userId });
  const packCards = args.include.cards ? await exportCards(reviewerId, views.carded) : [];
  return {
    topicName: topic.name,
    packName: reviewer.name,
    lockedIn: withActiveAnnotations(views.locked_in),
    summary: withActiveAnnotations(views.summary),
    cards: packCards,
  };
}
