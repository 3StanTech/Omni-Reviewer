import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  getActiveGenerationJobForReviewer,
  getLatestFullGenerationJobForReviewer,
  getLatestGenerationJobForReviewer,
  getReviewer,
  listAnnotationPageForReviewer,
} from "@/lib/queries";
import { views } from "@/lib/schema";
import {
  selectVisibleGenerationRows,
  manualStaleKinds,
  viewsPayloadFromRows,
} from "@/lib/serialize-view";

export const dynamic = "force-dynamic";

/**
 * Side-effect free: returns persisted views only. Does not call the model.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId } = await context.params;

  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const activeJob = await getActiveGenerationJobForReviewer(reviewerId, userId);
  const latestJob =
    activeJob ?? (await getLatestGenerationJobForReviewer(reviewerId, userId));
  const baselineCandidate =
    latestJob?.mode === "full"
      ? latestJob
      : await getLatestFullGenerationJobForReviewer(reviewerId, userId);
  const baselineFullJob =
    baselineCandidate?.mode === "full"
      ? {
          mode: "full" as const,
          generationRunId: baselineCandidate.generationRunId,
          step: baselineCandidate.step,
        }
      : null;
  const rows = await db
    .select()
    .from(views)
    .where(eq(views.reviewerId, reviewerId));
  const [lockedAnnotations, summaryAnnotations] = await Promise.all([
    listAnnotationPageForReviewer(reviewerId, userId, "locked_in"),
    listAnnotationPageForReviewer(reviewerId, userId, "summary"),
  ]);
  const annotationRows = [...lockedAnnotations.annotations, ...summaryAnnotations.annotations];
  const annotationNextCursors = {
    locked_in: lockedAnnotations.nextCursor,
    summary: summaryAnnotations.nextCursor,
  };

  if (!latestJob) {
    return NextResponse.json(
      viewsPayloadFromRows(rows, {
        staleKinds: manualStaleKinds(rows),
        annotations: annotationRows,
        annotationNextCursors,
      }),
    );
  }

  const visible = selectVisibleGenerationRows(rows, latestJob, baselineFullJob);

  return NextResponse.json(
    viewsPayloadFromRows(visible.rows, {
      currentGenerationRunId: visible.currentGenerationRunId,
      staleKinds: [...new Set([...visible.staleKinds, ...manualStaleKinds(rows)])],
      annotations: annotationRows,
      annotationNextCursors,
    }),
  );
}
