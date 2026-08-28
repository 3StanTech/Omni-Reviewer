import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  getGenerationJobForReviewer,
  getReviewer,
} from "@/lib/queries";
import { views } from "@/lib/schema";

export const dynamic = "force-dynamic";

function serializeView(row: typeof views.$inferSelect) {
  return {
    id: row.id,
    reviewerId: row.reviewerId,
    kind: row.kind,
    content: row.content,
    contentJson: row.contentJson ?? null,
    modelId: row.modelId ?? null,
    generatedAt: row.generatedAt.toISOString(),
  };
}

function serializeJob(job: NonNullable<Awaited<ReturnType<typeof getGenerationJobForReviewer>>>) {
  return {
    id: job.id,
    reviewerId: job.reviewerId,
    status: job.status,
    step: job.step,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    modelUsed: job.modelUsed,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Poll generation progress. Returns job row plus current four views.
 * Does not call the model.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; jobId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId, jobId } = await context.params;

  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const job = await getGenerationJobForReviewer(reviewerId, jobId, userId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(views)
    .where(eq(views.reviewerId, reviewerId));

  const byKind = {
    locked_in: null as ReturnType<typeof serializeView> | null,
    summary: null as ReturnType<typeof serializeView> | null,
    test_me: null as ReturnType<typeof serializeView> | null,
    carded: null as ReturnType<typeof serializeView> | null,
  };

  for (const row of rows) {
    if (row.kind === "locked_in") byKind.locked_in = serializeView(row);
    else if (row.kind === "summary") byKind.summary = serializeView(row);
    else if (row.kind === "test_me") byKind.test_me = serializeView(row);
    else if (row.kind === "carded") byKind.carded = serializeView(row);
  }

  return NextResponse.json({
    job: serializeJob(job),
    status: job.status,
    step: job.step,
    views: byKind,
    error:
      job.errorCode || job.errorMessage
        ? {
            code: job.errorCode,
            message: job.errorMessage,
            retryable:
              job.errorCode === "rate_limited" ||
              job.errorCode === "unavailable" ||
              job.errorCode === "timeout" ||
              job.errorCode === "json_parse",
          }
        : null,
  });
}
