import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { missingUpstreamMessage, parseGenerateBody } from "@/lib/generate-request";
import { planGeneration, type GenerateKind } from "@/lib/generation-plan";
import {
  createOrReuseGenerationJob,
  getGenerationExistingKinds,
  getGenerationUpstreamRevisions,
  getActiveGenerationJobForReviewer,
  getLatestFullGenerationJobForReviewer,
  getLatestGenerationJobForReviewer,
  getLatestView,
  getReviewer,
  protectedContentForGeneration,
  reactivateGenerationJobForResume,
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
        userId,
        latestJob: active,
        baselineFullJob: fullBaseline?.mode === "full"
          ? { mode: "full", generationRunId: fullBaseline.generationRunId, step: fullBaseline.step }
          : null,
      }),
    });
  }

  // A terminal full run owns a frozen target scope. Resume it before planning
  // a fresh missing-mode run, including the case where all views persisted but
  // the response was lost before the success metadata commit.
  if (parsed.intent === "generate_missing") {
    const latest = await getLatestGenerationJobForReviewer(reviewerId, userId);
    if (
      latest?.mode === "full" &&
      !latest.active &&
      (latest.status === "partial" || latest.status === "failed") &&
      latest.step
    ) {
      const resumed = await reactivateGenerationJobForResume({
        id: latest.id,
        reviewerId,
        userId,
      });
      if (resumed) {
        const resumedBaseline = resumed.mode === "single"
          ? await getLatestFullGenerationJobForReviewer(reviewerId, userId)
          : null;
        return NextResponse.json({
          jobId: resumed.id,
          status: resumed.status,
          step: resumed.step,
          job: serializeGenerationJob(resumed),
          views: await loadGenerationViews(reviewerId, {
            userId,
            latestJob: resumed,
            baselineFullJob: resumedBaseline?.mode === "full"
              ? {
                  mode: "full",
                  generationRunId: resumedBaseline.generationRunId,
                  step: resumedBaseline.step,
                }
              : null,
          }),
        });
      }
    }
  }

  const existing = await getGenerationExistingKinds(reviewerId, userId);
  const plan = planGeneration({
    intent: parsed.intent,
    kind: parsed.kind,
    scope: parsed.scope,
    existing,
  });

  if (plan.noOp) {
    return NextResponse.json({
      jobId: null,
      status: "succeeded",
      step: null,
      noOp: true,
      message: "All study modes are already generated. No model call was made.",
      job: null,
      views: await loadGenerationViews(reviewerId, { userId }),
    });
  }

  const kind = parsed.kind;
  const forceOverwrite = parsed.intent === "redo" && (parsed.forceOverwrite ?? false);
  const protectedRevisions = parsed.intent === "redo" && kind
    ? await protectedContentForGeneration(
        reviewerId,
        userId,
        plan.scope === "full" ? "locked_in" : kind,
      )
    : [];
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
  if (plan.targetKinds.includes("locked_in")) {
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
  }

  for (const targetKind of plan.targetKinds) {
    const upstreamKind: GenerateKind | null =
      targetKind === "carded"
        ? "summary"
        : targetKind === "summary" || targetKind === "test_me"
          ? "locked_in"
          : null;
    if (upstreamKind && !plan.targetKinds.includes(upstreamKind)) {
      const upstream = await getLatestView(reviewerId, upstreamKind);
      if (!upstream?.content?.trim()) {
        return NextResponse.json(
          { error: missingUpstreamMessage(targetKind) },
          { status: 400 },
        );
      }
    }
  }

  const upstreamRevisions = await getGenerationUpstreamRevisions(
    reviewerId,
    userId,
    plan.targetKinds,
  );

  const { job } = await createOrReuseGenerationJob({
    userId,
    reviewerId,
    status: "queued",
    step: plan.initialStep,
    mode: plan.mode,
    intent: plan.intent,
    targetKinds: plan.targetKinds,
    completedKinds: [],
    upstreamRevisions,
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
      userId,
      latestJob: job,
      baselineFullJob: fullBaseline?.mode === "full"
        ? { mode: "full", generationRunId: fullBaseline.generationRunId, step: fullBaseline.step }
        : null,
    }),
  });
}
