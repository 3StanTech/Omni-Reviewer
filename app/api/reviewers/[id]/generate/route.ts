import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  generateCarded,
  generateStudyPack,
  generateSummary,
  generateTestMe,
  type StudyPackStep,
  StudyPackJsonError,
} from "@/lib/ai";
import { db } from "@/lib/db";
import {
  classifyGenerationError,
  toGenerationError,
} from "@/lib/generation-errors";
import {
  missingUpstreamMessage,
  parseGenerateBody,
} from "@/lib/generate-request";
import {
  createGenerationJob,
  getReviewer,
  updateGenerationJob,
} from "@/lib/queries";
import { reviewers, sources, views } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ViewKind = "locked_in" | "summary" | "test_me" | "carded";

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

async function upsertView(args: {
  reviewerId: string;
  kind: ViewKind;
  content: string;
  contentJson: unknown | null;
  modelId: string | null;
  generatedAt: Date;
}) {
  const [row] = await db
    .insert(views)
    .values({
      reviewerId: args.reviewerId,
      kind: args.kind,
      content: args.content,
      contentJson: args.contentJson,
      modelId: args.modelId,
      generatedAt: args.generatedAt,
    })
    .onConflictDoUpdate({
      target: [views.reviewerId, views.kind],
      set: {
        content: args.content,
        contentJson: args.contentJson,
        modelId: args.modelId,
        generatedAt: args.generatedAt,
      },
    })
    .returning();

  return row;
}

async function loadViewsPayload(reviewerId: string) {
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

  return byKind;
}

const NEXT_STEP: Record<StudyPackStep, StudyPackStep | null> = {
  locked_in: "summary",
  summary: "test_me",
  test_me: "carded",
  carded: null,
};

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

  const rawBody = await request.text();
  const parsed = parseGenerateBody(rawBody);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const kind = parsed.kind;

  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  if (kind !== "locked_in") {
    const generatedAt = new Date();
    const existing = await loadViewsPayload(reviewerId);
    try {
      if (kind === "summary" || kind === "test_me") {
        const lockedIn = existing.locked_in?.content?.trim() ?? "";
        if (!lockedIn) {
          return NextResponse.json(
            { error: missingUpstreamMessage(kind) },
            { status: 400 },
          );
        }
        if (kind === "summary") {
          const summary = await generateSummary(lockedIn);
          await upsertView({
            reviewerId,
            kind: "summary",
            content: summary,
            contentJson: null,
            modelId: null,
            generatedAt,
          });
        } else {
          const testMe = await generateTestMe(lockedIn);
          await upsertView({
            reviewerId,
            kind: "test_me",
            content: JSON.stringify(testMe),
            contentJson: testMe,
            modelId: null,
            generatedAt,
          });
        }
      } else {
        const summary = existing.summary?.content?.trim() ?? "";
        if (!summary) {
          return NextResponse.json(
            { error: missingUpstreamMessage("carded") },
            { status: 400 },
          );
        }
        const carded = await generateCarded(summary);
        await upsertView({
          reviewerId,
          kind: "carded",
          content: JSON.stringify(carded),
          contentJson: carded,
          modelId: null,
          generatedAt,
        });
      }
    } catch (err) {
      const classified = classifyGenerationError(
        err instanceof StudyPackJsonError ? err : toGenerationError(err),
      );
      return NextResponse.json(
        { error: classified.message, code: classified.code },
        { status: 502 },
      );
    }

    await db
      .update(reviewers)
      .set({ lastGeneratedAt: generatedAt })
      .where(eq(reviewers.id, reviewerId));

    return NextResponse.json(await loadViewsPayload(reviewerId));
  }

  const allSources = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.reviewerId, reviewerId),
        eq(sources.ingestStatus, "ready"),
      ),
    );

  const extractedTexts = allSources
    .filter(
      (s) =>
        typeof s.extractedText === "string" && s.extractedText.trim().length > 0,
    )
    .map((s) => ({
      filename: s.filename,
      text: s.extractedText as string,
    }));

  if (extractedTexts.length === 0) {
    return NextResponse.json(
      {
        error:
          "No ingested sources to generate from. Video and audio are not processed in v1.",
      },
      { status: 400 },
    );
  }

  const job = await createGenerationJob({
    userId,
    reviewerId,
    status: "running",
    step: "locked_in",
    errorCode: null,
    errorMessage: null,
    modelUsed: null,
    finishedAt: null,
  });

  let lastCompletedStep: StudyPackStep | null = null;

  try {
    await generateStudyPack({
      extractedTexts,
      onStep: async ({ step, payload, modelUsed }) => {
        const generatedAt = new Date();
        if (payload.kind === "locked_in" || payload.kind === "summary") {
          await upsertView({
            reviewerId,
            kind: payload.kind,
            content: payload.content,
            contentJson: null,
            modelId: modelUsed,
            generatedAt,
          });
        } else {
          await upsertView({
            reviewerId,
            kind: payload.kind,
            content: JSON.stringify(payload.content),
            contentJson: payload.content,
            modelId: modelUsed,
            generatedAt,
          });
        }

        lastCompletedStep = step;
        const next = NEXT_STEP[step];
        await updateGenerationJob(job.id, {
          status: "running",
          step: next ?? step,
          modelUsed,
        });
      },
    });

    const finishedAt = new Date();
    await updateGenerationJob(job.id, {
      status: "succeeded",
      step: "carded",
      finishedAt,
      errorCode: null,
      errorMessage: null,
    });

    await db
      .update(reviewers)
      .set({ lastGeneratedAt: finishedAt })
      .where(eq(reviewers.id, reviewerId));

    const viewsPayload = await loadViewsPayload(reviewerId);
    return NextResponse.json({
      jobId: job.id,
      status: "succeeded",
      step: "carded",
      views: viewsPayload,
    });
  } catch (err) {
    const classified = classifyGenerationError(
      err instanceof StudyPackJsonError ? err : toGenerationError(err),
    );
    const finishedAt = new Date();
    const status = lastCompletedStep ? "partial" : "failed";

    await updateGenerationJob(job.id, {
      status,
      step: lastCompletedStep,
      errorCode: classified.code,
      errorMessage: classified.message,
      finishedAt,
    });

    if (lastCompletedStep) {
      await db
        .update(reviewers)
        .set({ lastGeneratedAt: finishedAt })
        .where(eq(reviewers.id, reviewerId));
    }

    const viewsPayload = await loadViewsPayload(reviewerId);
    const httpStatus =
      classified.code === "payment_required"
        ? 402
        : classified.code === "rate_limited"
          ? 429
          : classified.code === "token_limit"
            ? 400
            : 502;

    return NextResponse.json(
      {
        jobId: job.id,
        status,
        step: lastCompletedStep,
        views: viewsPayload,
        error: classified,
      },
      { status: httpStatus },
    );
  }
}
