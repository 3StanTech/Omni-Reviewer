import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { publicGenerationErrorMessage } from "@/lib/generation-errors";
import { generationJobs, views } from "@/lib/schema";
import {
  manualStaleKinds,
  selectVisibleGenerationRows,
  viewsPayloadFromRows,
} from "@/lib/serialize-view";

export type GenerationViewKind = "locked_in" | "summary" | "test_me" | "carded";

export async function loadGenerationViews(
  reviewerId: string,
  options?: string | {
    latestJob?: {
      mode: "full" | "single";
      generationRunId: string;
      step: string | null;
      active?: boolean;
    } | null;
    baselineFullJob?: {
      mode: "full";
      generationRunId: string;
      step: string | null;
    } | null;
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

  if (typeof options === "object" && options?.latestJob) {
    const visible = selectVisibleGenerationRows(
      rows,
      options.latestJob,
      options.baselineFullJob ?? null,
    );
    return viewsPayloadFromRows(visible.rows, {
      currentGenerationRunId: visible.currentGenerationRunId,
      staleKinds: [...new Set([...visible.staleKinds, ...manualStaleKinds(rows)])],
    });
  }
  return viewsPayloadFromRows(rows, {
    currentGenerationRunId: generationRunId ?? null,
    staleKinds: manualStaleKinds(rows),
  });
}

export function serializeGenerationJob(job: typeof generationJobs.$inferSelect) {
  return {
    id: job.id,
    reviewerId: job.reviewerId,
    status: job.status,
    step: job.step,
    mode: job.mode,
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
