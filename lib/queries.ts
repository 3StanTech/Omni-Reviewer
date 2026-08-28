import "server-only";

import { and, asc, eq, max } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  generationJobs,
  reviewers,
  sources,
  topics,
  views,
  type GenerationJob,
  type NewGenerationJob,
  type NewSource,
  type Reviewer,
  type Source,
  type Topic,
} from "@/lib/schema";

export async function listTopics(userId: string): Promise<Topic[]> {
  return db
    .select()
    .from(topics)
    .where(eq(topics.userId, userId))
    .orderBy(asc(topics.sortOrder), asc(topics.createdAt));
}

export async function getTopic(
  id: string,
  userId: string,
): Promise<Topic | null> {
  const [row] = await db
    .select()
    .from(topics)
    .where(and(eq(topics.id, id), eq(topics.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function createTopic(userId: string, name: string): Promise<Topic> {
  const [agg] = await db
    .select({ maxOrder: max(topics.sortOrder) })
    .from(topics)
    .where(eq(topics.userId, userId));
  const sortOrder = (agg?.maxOrder ?? -1) + 1;
  const [row] = await db
    .insert(topics)
    .values({ userId, name, sortOrder })
    .returning();
  return row;
}

export async function renameTopic(
  id: string,
  userId: string,
  name: string,
): Promise<Topic | null> {
  const [row] = await db
    .update(topics)
    .set({ name })
    .where(and(eq(topics.id, id), eq(topics.userId, userId)))
    .returning();
  return row ?? null;
}

/** Cascade deletes reviewers/sources/views via FK. */
export async function deleteTopic(
  id: string,
  userId: string,
): Promise<Topic | null> {
  const [row] = await db
    .delete(topics)
    .where(and(eq(topics.id, id), eq(topics.userId, userId)))
    .returning();
  return row ?? null;
}

export async function listReviewersByTopic(
  topicId: string,
  userId: string,
): Promise<Reviewer[]> {
  return db
    .select({
      id: reviewers.id,
      topicId: reviewers.topicId,
      name: reviewers.name,
      createdAt: reviewers.createdAt,
      lastGeneratedAt: reviewers.lastGeneratedAt,
    })
    .from(reviewers)
    .innerJoin(topics, eq(reviewers.topicId, topics.id))
    .where(and(eq(reviewers.topicId, topicId), eq(topics.userId, userId)))
    .orderBy(asc(reviewers.createdAt));
}

export async function getReviewer(
  id: string,
  userId: string,
): Promise<Reviewer | null> {
  const [row] = await db
    .select({
      id: reviewers.id,
      topicId: reviewers.topicId,
      name: reviewers.name,
      createdAt: reviewers.createdAt,
      lastGeneratedAt: reviewers.lastGeneratedAt,
    })
    .from(reviewers)
    .innerJoin(topics, eq(reviewers.topicId, topics.id))
    .where(and(eq(reviewers.id, id), eq(topics.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function createReviewer(
  topicId: string,
  userId: string,
  name: string,
): Promise<Reviewer | null> {
  const topic = await getTopic(topicId, userId);
  if (!topic) return null;
  const [row] = await db
    .insert(reviewers)
    .values({ topicId, name })
    .returning();
  return row;
}

export async function renameReviewer(
  id: string,
  userId: string,
  name: string,
): Promise<Reviewer | null> {
  const existing = await getReviewer(id, userId);
  if (!existing) return null;
  const [row] = await db
    .update(reviewers)
    .set({ name })
    .where(eq(reviewers.id, id))
    .returning();
  return row ?? null;
}

/** Cascade deletes sources/views via FK. */
export async function deleteReviewer(
  id: string,
  userId: string,
): Promise<Reviewer | null> {
  const existing = await getReviewer(id, userId);
  if (!existing) return null;
  const [row] = await db
    .delete(reviewers)
    .where(eq(reviewers.id, id))
    .returning();
  return row ?? null;
}

export async function listSourcesByReviewer(
  reviewerId: string,
  userId: string,
): Promise<Source[]> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  return db
    .select()
    .from(sources)
    .where(eq(sources.reviewerId, reviewerId))
    .orderBy(asc(sources.createdAt));
}

/** Source rows for UI/list APIs. Omits lecture-sized extractedText. */
export async function listSourcesForUi(reviewerId: string, userId: string) {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  return db
    .select({
      id: sources.id,
      reviewerId: sources.reviewerId,
      filename: sources.filename,
      mime: sources.mime,
      kind: sources.kind,
      blobUrl: sources.blobUrl,
      blobPathname: sources.blobPathname,
      ingestStatus: sources.ingestStatus,
      errorMessage: sources.errorMessage,
      createdAt: sources.createdAt,
    })
    .from(sources)
    .where(eq(sources.reviewerId, reviewerId))
    .orderBy(asc(sources.createdAt));
}

/** View identity and timestamps only. No markdown/JSON bodies. */
export async function listViewMetaByReviewer(reviewerId: string, userId: string) {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return [];
  return db
    .select({
      id: views.id,
      reviewerId: views.reviewerId,
      kind: views.kind,
      modelId: views.modelId,
      generatedAt: views.generatedAt,
    })
    .from(views)
    .where(eq(views.reviewerId, reviewerId));
}

export async function getSource(id: string, userId: string): Promise<Source | null> {
  const [row] = await db
    .select({
      id: sources.id,
      reviewerId: sources.reviewerId,
      filename: sources.filename,
      mime: sources.mime,
      kind: sources.kind,
      blobUrl: sources.blobUrl,
      blobPathname: sources.blobPathname,
      ingestStatus: sources.ingestStatus,
      extractedText: sources.extractedText,
      errorMessage: sources.errorMessage,
      createdAt: sources.createdAt,
    })
    .from(sources)
    .innerJoin(reviewers, eq(sources.reviewerId, reviewers.id))
    .innerJoin(topics, eq(reviewers.topicId, topics.id))
    .where(and(eq(sources.id, id), eq(topics.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function getSourceForReviewer(
  reviewerId: string,
  sourceId: string,
  userId: string,
): Promise<Source | null> {
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return null;
  const [row] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.reviewerId, reviewerId)))
    .limit(1);
  return row ?? null;
}

export async function createSource(
  values: Omit<NewSource, "id" | "createdAt"> &
    Partial<Pick<NewSource, "id" | "createdAt">>,
): Promise<Source> {
  const [row] = await db.insert(sources).values(values).returning();
  return row;
}

export async function deleteSource(id: string): Promise<Source | null> {
  const [row] = await db
    .delete(sources)
    .where(eq(sources.id, id))
    .returning();
  return row ?? null;
}

export async function createGenerationJob(
  values: Omit<NewGenerationJob, "id" | "createdAt" | "updatedAt"> &
    Partial<Pick<NewGenerationJob, "id" | "createdAt" | "updatedAt">>,
): Promise<GenerationJob> {
  const now = values.updatedAt ?? new Date();
  const [row] = await db
    .insert(generationJobs)
    .values({ ...values, updatedAt: now })
    .returning();
  return row;
}

export async function updateGenerationJob(
  id: string,
  patch: Partial<
    Pick<
      GenerationJob,
      | "status"
      | "step"
      | "errorCode"
      | "errorMessage"
      | "modelUsed"
      | "finishedAt"
    >
  >,
): Promise<GenerationJob | null> {
  const [row] = await db
    .update(generationJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(generationJobs.id, id))
    .returning();
  return row ?? null;
}

export async function getGenerationJobForReviewer(
  reviewerId: string,
  jobId: string,
  userId: string,
): Promise<GenerationJob | null> {
  const [row] = await db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.reviewerId, reviewerId),
        eq(generationJobs.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}
