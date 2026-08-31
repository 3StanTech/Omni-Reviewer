import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { missingUpstreamMessage, parseGenerateBody } from "@/lib/generate-request";
import {
  createOrReuseGenerationJob,
  getActiveGenerationJobForReviewer,
  getLatestFullGenerationJobForReviewer,
  getLatestView,
  getReviewer,
  protectedContentForGeneration,
} from "@/lib/queries";
import { sources } from "@/lib/schema";
import {
  loadGenerationViews,
  serializeGenerationJob,
} from "@/lib/generation-jobs";
import {
  cappedBodyError,
  MAX_GENERATE_BODY_BYTES,
  readCappedText,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

type ViewKind = "locked_in" | "summary" | "test_me" | "carded";


/**
 * Start or resume a generation run. This route deliberately never calls the
 * model; one step request owns one provider operation.
 */
export async function POST(
  request: Request,
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

  let rawBody: string;
  try {
    rawBody = await readCappedText(request, {
      maxBytes: MAX_GENERATE_BODY_BYTES,
      allowEmpty: true,
      tooLargeMessage: "Generate request body exceeds the safe size limit",
      invalidMessage: "Invalid JSON body",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = parseGenerateBody(rawBody);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // Idempotency is checked before source/upstream validation so a retry of a
  // valid in-flight run always receives the same job, even if source state has
  // changed since the first click.
  const active = await getActiveGenerationJobForReviewer(reviewerId, userId);
  if (active) {
    const fullBaseline = active.mode === "single"
      ? await getLatestFullGenerationJobForReviewer(reviewerId, userId)
      : null;
    return NextResponse.json({
      jobId: active.id,
      status: active.status,
      step: active.step,
      job: serializeGenerationJob(active),
      views: await loadGenerationViews(reviewerId, {
        latestJob: active,
        baselineFullJob: fullBaseline?.mode === "full"
          ? { mode: "full", generationRunId: fullBaseline.generationRunId, step: fullBaseline.step }
          : null,
      }),
    });
  }

  const kind = parsed.kind;
  const forceOverwrite = parsed.forceOverwrite ?? false;
  const protectedRevisions = await protectedContentForGeneration(reviewerId, userId, kind);
  const expectedProtected = parsed.expectedProtected ?? [];
  const expectedByKey = new Map(expectedProtected.map((entry) => [entry.key, entry.revision]));
  const protectionDrifted = protectedRevisions.some(
    (entry) => expectedByKey.get(entry.key) !== entry.revision,
  );
  if (protectedRevisions.length > 0 && (!forceOverwrite || protectionDrifted)) {
    return NextResponse.json(
      {
        error: "Some study content has been edited or pinned. Confirm overwrite to continue.",
        requiresConfirmation: true,
        stale: forceOverwrite && protectionDrifted,
        protectedKinds: protectedRevisions.map((entry) => entry.key),
        expectedProtected: protectedRevisions,
      },
      { status: 409 },
    );
  }
  if (kind === "locked_in") {
    const readySources = await db
      .select({ extractedText: sources.extractedText })
      .from(sources)
      .where(
        and(
          eq(sources.reviewerId, reviewerId),
          eq(sources.ingestStatus, "ready"),
        ),
      );
    const hasExtractedText = readySources.some(
      (source) => Boolean(source.extractedText?.trim()),
    );
    if (!hasExtractedText) {
      return NextResponse.json(
        {
          error:
            "No ingested sources to generate from. Video and audio are not processed in v1.",
        },
        { status: 400 },
      );
    }
  } else {
    const upstreamKind: ViewKind = kind === "carded" ? "summary" : "locked_in";
    const upstream = await getLatestView(reviewerId, upstreamKind);
    if (!upstream?.content?.trim()) {
      return NextResponse.json(
        { error: missingUpstreamMessage(kind) },
        { status: 400 },
      );
    }
  }

  const { job } = await createOrReuseGenerationJob({
    userId,
    reviewerId,
    status: "queued",
    step: kind,
    mode: kind === "locked_in" ? "full" : "single",
    errorCode: null,
    errorMessage: null,
    modelUsed: null,
    forceOverwrite,
    active: true,
    claimToken: null,
    claimExpiresAt: null,
    claimedAt: null,
    finishedAt: null,
    expectedProtected: forceOverwrite ? protectedRevisions : null,
  });

  const fullBaseline = job.mode === "single"
    ? await getLatestFullGenerationJobForReviewer(reviewerId, userId)
    : null;
  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    step: job.step,
    job: serializeGenerationJob(job),
    views: await loadGenerationViews(reviewerId, {
      latestJob: job,
      baselineFullJob: fullBaseline?.mode === "full"
        ? { mode: "full", generationRunId: fullBaseline.generationRunId, step: fullBaseline.step }
        : null,
    }),
  });
}
