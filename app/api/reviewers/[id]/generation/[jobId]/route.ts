import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  classifyGenerationError,
  parseProviderError,
  publicGenerationErrorMessage,
} from "@/lib/generation-errors";
import {
  loadGenerationViews,
  serializeGenerationJob,
} from "@/lib/generation-jobs";
import {
  claimGenerationJobStep,
  getGenerationJobForReviewer,
  getLatestFullGenerationJobForReviewer,
  getLatestView,
  getReviewer,
  getViewForGeneration,
  persistViewForActiveClaim,
  syncGeneratedCards,
  updateClaimedGenerationJob,
} from "@/lib/queries";
import { logRedactedError } from "@/lib/public-errors";
import {
  runGenerationStep,
  type StudyPackStep,
} from "@/lib/generation-step";
import { parseCardedItems } from "@/lib/learning";
import { generationJobs, reviewers, sources } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NEXT_STEP: Record<StudyPackStep, StudyPackStep | null> = {
  locked_in: "summary",
  summary: "test_me",
  test_me: "carded",
  carded: null,
};

type JobRow = typeof generationJobs.$inferSelect;

function retryableError(code: string | null): boolean {
  return (
    code === "rate_limited" ||
    code === "unavailable" ||
    code === "timeout" ||
    code === "json_parse"
  );
}

async function responseForJob(
  reviewerId: string,
  userId: string,
  job: JobRow,
  status = 200,
) {
  const fullBaseline = job.mode === "single"
    ? await getLatestFullGenerationJobForReviewer(reviewerId, userId)
    : null;
  const viewsPayload = await loadGenerationViews(
    reviewerId,
    {
      latestJob: job,
      baselineFullJob: fullBaseline?.mode === "full"
        ? { mode: "full", generationRunId: fullBaseline.generationRunId, step: fullBaseline.step }
        : null,
    },
  );
  const safeErrorMessage = publicGenerationErrorMessage(
    job.errorCode,
    job.errorMessage,
  );
  return NextResponse.json(
    {
      job: serializeGenerationJob(job),
      status: job.status,
      step: job.step,
      views: viewsPayload,
      error:
        safeErrorMessage
          ? {
              code: job.errorCode,
              message: safeErrorMessage,
              retryable: retryableError(job.errorCode),
            }
          : null,
    },
    { status },
  );
}

async function responseForStaleClaim(
  reviewerId: string,
  userId: string,
  job: JobRow,
  claimToken: string,
  message = "Study content changed while generating. Refresh and confirm overwrite.",
) {
  const stale = await updateClaimedGenerationJob(job.id, claimToken, {
    status: "partial",
    step: job.step,
    errorCode: "stale",
    errorMessage: message,
    active: false,
    finishedAt: new Date(),
    claimToken: null,
    claimExpiresAt: null,
    claimedAt: null,
  });
  if (stale) return responseForJob(reviewerId, userId, stale, 409);
  const latest = await getGenerationJobForReviewer(reviewerId, job.id, userId);
  if (!latest) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return responseForJob(reviewerId, userId, latest, latest.active ? 202 : 409);
}

async function getStepInput(job: JobRow, step: StudyPackStep) {
  if (step === "locked_in") {
    const rows = await db
      .select({ filename: sources.filename, text: sources.extractedText })
      .from(sources)
      .where(
        and(
          eq(sources.reviewerId, job.reviewerId),
          eq(sources.ingestStatus, "ready"),
        ),
      );
    const extractedTexts = rows
      .filter((row): row is { filename: string; text: string } => Boolean(row.text?.trim()))
      .map((row) => ({ filename: row.filename, text: row.text }));
    return { extractedTexts };
  }

  const upstreamKind = step === "carded" ? "summary" : "locked_in";
  const upstream =
    job.mode === "full"
      ? await getViewForGeneration(
          job.reviewerId,
          upstreamKind,
          job.generationRunId,
        )
      : await getLatestView(job.reviewerId, upstreamKind);

  if (!upstream?.content?.trim()) {
    throw new Error(
      `Cannot generate ${step}: the required ${upstreamKind} view is not available for this run`,
    );
  }

  return upstreamKind === "locked_in"
    ? { lockedIn: upstream.content }
    : { summary: upstream.content };
}

/** Polling endpoint. GET is side-effect free and never calls the model. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; jobId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: reviewerId, jobId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });

  const job = await getGenerationJobForReviewer(reviewerId, jobId, userId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return responseForJob(reviewerId, userId, job);
}

/**
 * Claim and execute one current step. Concurrent calls either observe the
 * existing lease or one atomically wins it; neither can issue two calls for
 * the same live step.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; jobId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: reviewerId, jobId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });

  const current = await getGenerationJobForReviewer(reviewerId, jobId, userId);
  if (!current) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (!current.active || !current.step) return responseForJob(reviewerId, userId, current);

  const step = current.step as StudyPackStep;
  const claimToken = crypto.randomUUID();
  // The lease exceeds the route's maximum duration, while still allowing a
  // crashed invocation to be recovered without manual cleanup.
  const claimExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const claimed = await claimGenerationJobStep({
    id: current.id,
    reviewerId,
    userId,
    step,
    claimToken,
    claimExpiresAt,
  });

  if (!claimed) {
    const latest = await getGenerationJobForReviewer(reviewerId, jobId, userId);
    if (!latest) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return responseForJob(reviewerId, userId, latest, latest.active ? 202 : 200);
  }

  try {
    // If an invocation published its view but lost the response before
    // advancing the job, finish that exact step without charging the model a
    // second time. The run id prevents an older view from satisfying this.
    const alreadyPersisted = await getViewForGeneration(
      claimed.reviewerId,
      step,
      claimed.generationRunId,
    );
    if (alreadyPersisted) {
      if (step === "carded") {
        const cardsSynced = await syncGeneratedCards({
          jobId: claimed.id,
          claimToken,
          reviewerId,
          userId,
          items: parseCardedItems(alreadyPersisted.contentJson, alreadyPersisted.content),
          generationRunId: claimed.generationRunId,
        });
        if (!cardsSynced) {
          return responseForStaleClaim(reviewerId, userId, claimed, claimToken);
        }
      }
      const next = claimed.mode === "single" ? null : NEXT_STEP[step];
      const finished = next === null;
      const completed = await updateClaimedGenerationJob(claimed.id, claimToken, {
        status: finished ? "succeeded" : "running",
        step: finished ? step : next,
        modelUsed: alreadyPersisted.modelId,
        errorCode: null,
        errorMessage: null,
        active: !finished,
        finishedAt: finished ? alreadyPersisted.generatedAt : null,
        claimToken: null,
        claimExpiresAt: null,
        claimedAt: null,
      });
      if (!completed) {
        const latest = await getGenerationJobForReviewer(reviewerId, jobId, userId);
        if (!latest) return NextResponse.json({ error: "Job not found" }, { status: 404 });
        return responseForJob(reviewerId, userId, latest, latest.active ? 202 : 200);
      }
      return responseForJob(reviewerId, userId, completed);
    }

    const input = await getStepInput(claimed, step);
    const generated = await runGenerationStep({ step, ...input });
    const generatedAt = new Date();
    const contentJson =
      generated.payload.kind === "locked_in" || generated.payload.kind === "summary"
        ? null
        : generated.payload.content;
    const content =
      typeof generated.payload.content === "string"
        ? generated.payload.content
        : JSON.stringify(generated.payload.content);

    // Publish and refresh the model provenance only while this exact claim is
    // active. This is one conditional SQL statement, so a stale worker cannot
    // overwrite a view after a lease recovery.
    const persisted = await persistViewForActiveClaim({
      jobId: claimed.id,
      reviewerId,
      userId,
      claimToken,
      generationRunId: claimed.generationRunId,
      step,
      content,
      contentJson,
      modelUsed: generated.modelUsed,
      generatedAt,
      forceOverwrite: claimed.forceOverwrite,
    });
    if (!persisted) {
      const stale = await updateClaimedGenerationJob(claimed.id, claimToken, {
        status: "partial",
        step,
        errorCode: "stale",
        errorMessage: "Study content changed while generating. Refresh and confirm overwrite.",
        active: false,
        finishedAt: generatedAt,
        claimToken: null,
        claimExpiresAt: null,
        claimedAt: null,
      });
      if (stale) return responseForJob(reviewerId, userId, stale, 409);
      const latest = await getGenerationJobForReviewer(reviewerId, jobId, userId);
      if (!latest) return NextResponse.json({ error: "Job not found" }, { status: 404 });
      return responseForJob(reviewerId, userId, latest, latest.active ? 202 : 200);
    }

    if (step === "carded" && generated.payload.kind === "carded") {
      const cardsSynced = await syncGeneratedCards({
        jobId: claimed.id,
        claimToken,
        reviewerId,
        userId,
        items: generated.payload.content,
        generationRunId: claimed.generationRunId,
      });
      if (!cardsSynced) {
        return responseForStaleClaim(reviewerId, userId, claimed, claimToken);
      }
    }

    const next = claimed.mode === "single" ? null : NEXT_STEP[step];
    const finished = next === null;
    const completed = await updateClaimedGenerationJob(claimed.id, claimToken, {
      status: finished ? "succeeded" : "running",
      step: finished ? step : next,
      modelUsed: generated.modelUsed,
      errorCode: null,
      errorMessage: null,
      active: !finished,
      finishedAt: finished ? generatedAt : null,
      claimToken: null,
      claimExpiresAt: null,
      claimedAt: null,
    });
    if (!completed) {
      const latest = await getGenerationJobForReviewer(reviewerId, jobId, userId);
      if (!latest) return NextResponse.json({ error: "Job not found" }, { status: 404 });
      return responseForJob(reviewerId, userId, latest, latest.active ? 202 : 200);
    }

    await db
      .update(reviewers)
      .set({ lastGeneratedAt: generatedAt })
      .where(eq(reviewers.id, reviewerId));

    return responseForJob(reviewerId, userId, completed);
  } catch (error) {
    const parsedError = parseProviderError(error);
    logRedactedError("Generation step failed", error, {
      reviewerId,
      jobId,
      step,
      providerStatus: parsedError.status,
      providerCode: parsedError.code,
      requestId: parsedError.requestId,
    });
    const classified = classifyGenerationError(error);
    const terminal = claimed.mode === "single" || step === "locked_in";
    const failed = await updateClaimedGenerationJob(claimed.id, claimToken, {
      status: terminal ? "failed" : "partial",
      step,
      errorCode: classified.code,
      errorMessage: classified.message,
      active: false,
      finishedAt: new Date(),
      claimToken: null,
      claimExpiresAt: null,
      claimedAt: null,
    });
    if (!failed) {
      const latest = await getGenerationJobForReviewer(reviewerId, jobId, userId);
      if (!latest) return NextResponse.json({ error: "Job not found" }, { status: 404 });
      return responseForJob(reviewerId, userId, latest, latest.active ? 202 : responseStatus(classified.code));
    }
    return responseForJob(reviewerId, userId, failed, responseStatus(classified.code));
  }
}

function responseStatus(code: string): number {
  if (code === "payment_required") return 402;
  if (code === "rate_limited") return 429;
  if (code === "token_limit") return 400;
  return 502;
}
