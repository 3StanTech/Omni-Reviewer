import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { loadGenerationViews, serializeGenerationJob } from "@/lib/generation-jobs";
import {
  getActiveGenerationJobForReviewer,
  getLatestFullGenerationJobForReviewer,
  getLatestGenerationJobForReviewer,
  getReviewer,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

/** Return the resumable job without starting any model work. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: reviewerId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });

  const job =
    (await getActiveGenerationJobForReviewer(reviewerId, userId)) ??
    (await getLatestGenerationJobForReviewer(reviewerId, userId));
  if (!job) return NextResponse.json({ job: null, views: null });

  const fullBaseline = job.mode === "single"
    ? await getLatestFullGenerationJobForReviewer(reviewerId, userId)
    : null;

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    step: job.step,
    job: serializeGenerationJob(job),
    views: await loadGenerationViews(
      reviewerId,
      {
        userId,
        latestJob: job,
        baselineFullJob: fullBaseline?.mode === "full"
          ? {
              mode: "full",
              generationRunId: fullBaseline.generationRunId,
              step: fullBaseline.step,
            }
          : null,
      },
    ),
  });
}
