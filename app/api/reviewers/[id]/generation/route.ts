import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { loadGenerationViews, serializeGenerationJob } from "@/lib/generation-jobs";
import {
  getActiveGenerationJobForReviewer,
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

  const job = await getActiveGenerationJobForReviewer(reviewerId, userId);
  if (!job) return NextResponse.json({ job: null, views: null });

  return NextResponse.json({
    job: serializeGenerationJob(job),
    views: await loadGenerationViews(
      reviewerId,
      job.mode === "full" ? job.generationRunId : undefined,
    ),
  });
}
