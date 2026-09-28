import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  readStudyDocumentMeta,
  type CitationSourceRef,
  type StudyDocumentMeta,
} from "@/lib/citations";
import { db } from "@/lib/db";
import {
  completedKindsForJob,
  firstIncompleteGenerationKind,
  generationStepKinds,
  nextPendingGenerationStep,
  normalizeCompletedKinds,
  targetKindsForJob,
} from "@/lib/generation-plan";
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
  completeClaimedGenerationJob,
  getGenerationJobForReviewer,
  getLatestFullGenerationJobForReviewer,
  getLatestView,
  getReviewer,
  getViewForGeneration,
  loadGroundingSources,
  persistViewForActiveClaim,
  reactivateGenerationJobForResume,
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
import { hasPageMarkers } from "@/lib/source-markers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
      userId,
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
      jobId: job.id,
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
    // A stable order keeps S1..Sn pointing at the same uploads on every run.
    const rows = await db
      .select({ id: sources.id, filename: sources.filename, text: sources.extractedText })
      .from(sources)
      .where(
        and(
          eq(sources.reviewerId, job.reviewerId),
          eq(sources.ingestStatus, "ready"),
        ),
      )
      .orderBy(asc(sources.createdAt), asc(sources.id));
    const extractedTexts = rows
      .filter((row): row is { id: string; filename: string; text: string } => Boolean(row.text?.trim()))
      .map((row) => ({ sourceId: row.id, filename: row.filename, text: row.text }));
    const citationSources: CitationSourceRef[] = extractedTexts.map((source, i) => ({
      index: i + 1,
      sourceId: source.sourceId,
      filename: source.filename,
      hasPages: hasPageMarkers(source.text),
    }));
    return { extractedTexts, citationSources };
  }

  const upstreamKind = step === "carded" ? "summary" : "locked_in";
  const targetKinds = targetKindsForJob(job);
  const upstream =
    job.mode === "full" && targetKinds.includes(upstreamKind)
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

  // Summary and Carded carry the same S<n> map as Locked In; legacy views have none.
  const citationSources = readStudyDocumentMeta(upstream.contentJson)?.citationSources ?? [];

  if (step === "summary") {
    return {
      lockedIn: upstream.content,
      citationSources,
      groundingSources: await loadGroundingSources(job.reviewerId, citationSources),
    };
  }
  return upstreamKind === "locked_in"
    ? { lockedIn: upstream.content, citationSources }
    : { summary: upstream.content, citationSources };
}

/**
 * Reload the cited source texts by id, scoped to this job's reviewer (whose
 * owner the caller already verified). A deleted source simply has no evidence.
 */
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

  let current = await getGenerationJobForReviewer(reviewerId, jobId, userId);
  if (!current) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (
    !current.active &&
    current.step &&
    (current.status === "partial" || current.status === "failed")
  ) {
    const resumed = await reactivateGenerationJobForResume({
      id: current.id,
      reviewerId,
      userId,
    });
    if (resumed && resumed.id !== current.id) {
      return responseForJob(reviewerId, userId, resumed, 202);
    }
    current = resumed ?? current;
  }
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

  const targetKinds = targetKindsForJob(claimed);
  // A multi-target Summary step also produces Test Me; both only need Locked In.
  const stepKinds = generationStepKinds(claimed, step) as StudyPackStep[];
  // Kinds persisted for this run inside this claim, including views an earlier
  // invocation published before it could advance the job.
  const persistedKinds: StudyPackStep[] = [];
  const upstreamRevisions: Record<string, number> = { ...(claimed.upstreamRevisions ?? {}) };

  const latestJobResponse = async (terminalStatus: number) => {
    const latest = await getGenerationJobForReviewer(reviewerId, jobId, userId);
    if (!latest) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return responseForJob(reviewerId, userId, latest, latest.active ? 202 : terminalStatus);
  };

  try {
    let stepModelUsed: string | null = null;
    let stepFinishedAt: Date | null = null;

    // If an invocation published a view but lost the response before
    // advancing the job, finish that exact kind without charging the model a
    // second time. The run id prevents an older view from satisfying this.
    const existingViews = await Promise.all(
      stepKinds.map((kind) =>
        getViewForGeneration(claimed.reviewerId, kind, claimed.generationRunId),
      ),
    );
    const pendingKinds: StudyPackStep[] = [];
    for (const [index, kind] of stepKinds.entries()) {
      const alreadyPersisted = existingViews[index];
      if (!alreadyPersisted) {
        pendingKinds.push(kind);
        continue;
      }
      if (kind === "carded") {
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
      persistedKinds.push(kind);
      upstreamRevisions[kind] = alreadyPersisted.revision;
      if (kind === step) {
        stepModelUsed = alreadyPersisted.modelId ?? "unknown";
        stepFinishedAt = alreadyPersisted.generatedAt;
      }
    }

    // Run every missing kind of this step concurrently; each call keeps its
    // own deadline, so the pair stays inside one route invocation.
    const settled = await Promise.allSettled(
      pendingKinds.map(async (kind) =>
        runGenerationStep({ step: kind, ...(await getStepInput(claimed, kind)) }),
      ),
    );

    let stepError: unknown = null;
    let companionError: unknown = null;
    for (const [index, kind] of pendingKinds.entries()) {
      const outcome = settled[index]!;
      try {
        if (outcome.status === "rejected") throw outcome.reason;
        const generated = outcome.value;
        const generatedAt = new Date();
        const contentJson: StudyDocumentMeta | unknown[] =
          generated.payload.kind === "locked_in" || generated.payload.kind === "summary"
            ? generated.meta ?? { citationSources: [] }
            : generated.payload.content;
        const content =
          typeof generated.payload.content === "string"
            ? generated.payload.content
            : JSON.stringify(generated.payload.content);

        // Publish and refresh the model provenance only while this exact
        // claim is active. This is one conditional SQL statement, so a stale
        // worker cannot overwrite a view after a lease recovery.
        const persisted = await persistViewForActiveClaim({
          jobId: claimed.id,
          reviewerId,
          userId,
          claimToken,
          generationRunId: claimed.generationRunId,
          step,
          kind,
          content,
          contentJson,
          modelUsed: generated.modelUsed,
          generatedAt,
          forceOverwrite: claimed.forceOverwrite,
          cardItems: generated.payload.kind === "carded" ? generated.payload.content : undefined,
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
          return latestJobResponse(200);
        }
        persistedKinds.push(kind);
        upstreamRevisions[kind] = persisted;
        if (kind === step) {
          stepModelUsed = generated.modelUsed;
          stepFinishedAt = generatedAt;
        }
      } catch (error) {
        if (kind === step) {
          // Keep publishing the companion kind; the step then fails below.
          stepError = error;
          continue;
        }
        companionError = error;
        const parsedError = parseProviderError(error);
        logRedactedError("Generation step failed", error, {
          reviewerId,
          jobId,
          step: kind,
          providerStatus: parsedError.status,
          providerCode: parsedError.code,
          requestId: parsedError.requestId,
        });
      }
    }
    if (stepError) throw stepError;

    const completedKinds = normalizeCompletedKinds(targetKinds, [
      ...completedKindsForJob(claimed),
      ...persistedKinds,
    ]);
    const next = claimed.mode === "single"
      ? null
      : nextPendingGenerationStep(targetKinds, stepKinds, completedKinds);
    // A kind this run has already passed but not persisted (Test Me failing
    // beside Summary) keeps the run from ever reporting success.
    const incomplete = firstIncompleteGenerationKind(targetKinds, completedKinds);
    const skipped =
      incomplete !== null &&
      (next === null || targetKinds.indexOf(incomplete) < targetKinds.indexOf(next));
    const carriedError = !skipped
      ? null
      : companionError
        ? classifyGenerationError(companionError)
        : { code: claimed.errorCode ?? "unknown", message: claimed.errorMessage ?? "" };
    const finishedAt = stepFinishedAt ?? new Date();
    const modelUsed = stepModelUsed ?? "unknown";

    const succeeded = next === null && incomplete === null;
    const completed = succeeded
      ? await completeClaimedGenerationJob({
          id: claimed.id,
          reviewerId,
          userId,
          claimToken,
          step,
          completedKinds,
          upstreamRevisions,
          modelUsed,
          finishedAt,
        })
      : await updateClaimedGenerationJob(claimed.id, claimToken, {
          // Ending with a missing kind is partial, so Resume fills it later.
          status: next === null ? "partial" : "running",
          step: next ?? incomplete,
          completedKinds,
          upstreamRevisions,
          modelUsed,
          errorCode: carriedError?.code ?? null,
          errorMessage: carriedError?.message ?? null,
          active: next !== null,
          finishedAt: next === null ? finishedAt : null,
          claimToken: null,
          claimExpiresAt: null,
          claimedAt: null,
        });
    if (!completed) return latestJobResponse(200);

    if (!succeeded) {
      await db
        .update(reviewers)
        .set({ lastGeneratedAt: finishedAt })
        .where(eq(reviewers.id, reviewerId));
    }

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
    const terminal = targetKinds.length === 1 || step === "locked_in";
    // A companion kind that did persist stays complete, so Resume skips it.
    const progress = persistedKinds.length > 0
      ? {
          completedKinds: normalizeCompletedKinds(targetKinds, [
            ...completedKindsForJob(claimed),
            ...persistedKinds,
          ]),
          upstreamRevisions,
        }
      : {};
    const failed = await updateClaimedGenerationJob(claimed.id, claimToken, {
      status: terminal ? "failed" : "partial",
      step,
      ...progress,
      errorCode: classified.code,
      errorMessage: classified.message,
      active: false,
      finishedAt: new Date(),
      claimToken: null,
      claimExpiresAt: null,
      claimedAt: null,
    });
    if (!failed) return latestJobResponse(responseStatus(classified.code));
    return responseForJob(reviewerId, userId, failed, responseStatus(classified.code));
  }
}

function responseStatus(code: string): number {
  if (code === "payment_required") return 402;
  if (code === "rate_limited") return 429;
  if (code === "token_limit") return 400;
  return 502;
}
