import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { publicGenerationErrorMessage } from "@/lib/generation-errors";
import {
  completedKindsForJob,
  generationProgress,
  targetKindsForJob,
  type GenerateKind,
} from "@/lib/generation-plan";
import { generationJobs, views } from "@/lib/schema";
import {
  manualStaleKinds,
  selectVisibleGenerationRows,
  viewsPayloadFromRows,
} from "@/lib/serialize-view";
import { listAnnotationPageForReviewer } from "@/lib/queries";

export type GenerationViewKind = "locked_in" | "summary" | "test_me" | "carded";

export async function loadGenerationViews(
  reviewerId: string,
  options?: string | {
    latestJob?: {
      mode: "full" | "single";
      generationRunId: string;
      step: string | null;
      intent?: "generate_missing" | "redo";
      targetKinds?: GenerateKind[] | null;
      completedKinds?: GenerateKind[] | null;
      active?: boolean;
    } | null;
    baselineFullJob?: {
      mode: "full";
      generationRunId: string;
      step: string | null;
    } | null;
    userId?: string;
  },
) {
  const generationRunId = typeof options === "string" ? options : undefined;
  const rows = await db
    .select()
    .from(views)
    .where(
      generationRunId
        ? and(
            eq(views.reviewerId, reviewerId),
            eq(views.generationRunId, generationRunId),
          )
        : eq(views.reviewerId, reviewerId),
    );

  const userId = typeof options === "object" ? options?.userId : undefined;
  const annotationPages = userId
    ? await Promise.all([
        listAnnotationPageForReviewer(reviewerId, userId, "locked_in"),
        listAnnotationPageForReviewer(reviewerId, userId, "summary"),
      ])
    : null;
  const annotations = annotationPages
    ? [...annotationPages[0].annotations, ...annotationPages[1].annotations]
    : undefined;
  const annotationNextCursors = annotationPages
    ? { locked_in: annotationPages[0].nextCursor, summary: annotationPages[1].nextCursor }
    : undefined;

  if (typeof options === "object" && options?.latestJob) {
    const visible = selectVisibleGenerationRows(
      rows,
      options.latestJob,
      options.baselineFullJob ?? null,
    );
    return viewsPayloadFromRows(visible.rows, {
      currentGenerationRunId: visible.currentGenerationRunId,
      staleKinds: [...new Set([...visible.staleKinds, ...manualStaleKinds(rows)])],
      annotations,
      annotationNextCursors,
    });
  }
  return viewsPayloadFromRows(rows, {
    currentGenerationRunId: generationRunId ?? null,
    staleKinds: manualStaleKinds(rows),
    annotations,
    annotationNextCursors,
  });
}

export function serializeGenerationJob(job: typeof generationJobs.$inferSelect) {
  const targetKinds = targetKindsForJob(job);
  const completedKinds = completedKindsForJob(job);
  const progress = generationProgress({
    targetKinds,
    completedKinds,
    status: job.status,
  });
  return {
    id: job.id,
    reviewerId: job.reviewerId,
    status: job.status,
    step: job.step,
    mode: job.mode,
    intent: job.intent ?? "redo",
    targetKinds,
    completedKinds,
    percentage: progress.percentage,
    progress: {
      completed: progress.completed,
      total: progress.total,
      percentage: progress.percentage,
    },
    generationRunId: job.generationRunId,
    active: job.active,
    errorCode: job.errorCode,
    errorMessage: publicGenerationErrorMessage(job.errorCode, job.errorMessage),
    modelUsed: job.modelUsed,
    forceOverwrite: job.forceOverwrite,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
