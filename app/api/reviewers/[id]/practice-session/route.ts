import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  createOrResumeUntimedPracticeSession,
  getReviewer,
  getUntimedPracticeSession,
  getViewForReviewer,
  restartUntimedPracticeSession,
  retryMissedUntimedPracticeSession,
  type UntimedPracticeSessionRow,
} from "@/lib/queries";
import {
  canRetryMissed,
  sittingProgress,
} from "@/lib/practice-session";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  intent: z.enum(["start", "start_again", "retry_missed"]).default("start"),
  originSessionId: z.string().uuid().optional(),
}).strict();

function sessionPayload(row: UntimedPracticeSessionRow, expectedRevision: number) {
  const progress = sittingProgress(row.itemIds, row.answers);
  return {
    sessionId: row.id,
    viewRevision: row.viewRevision,
    startedAt: row.startedAt.toISOString(),
    expiresAt: null,
    status: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
    itemIds: row.itemIds,
    originSessionId: row.originSessionId,
    answeredCount: progress.answeredCount,
    answers: row.answers,
    nextItemId: progress.nextItemId,
    nextIndex: progress.nextIndex,
    complete: progress.complete || row.status === "completed",
    correctCount: progress.correctCount,
    canRetryMissed: canRetryMissed({
      status: row.status,
      viewRevision: row.viewRevision,
      expectedRevision,
      itemIds: row.itemIds,
      answers: row.answers,
    }),
  };
}

async function authorizedReviewer(
  context: { params: Promise<{ id: string }> },
): Promise<
  | { response: NextResponse }
  | { userId: string; reviewerId: string }
> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { id: reviewerId } = await context.params;
  if (!(await getReviewer(reviewerId, userId))) {
    return { response: NextResponse.json({ error: "Reviewer not found" }, { status: 404 }) };
  }
  return { userId, reviewerId };
}

function parseExpectedRevision(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get("expectedRevision");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const revision = Number(raw);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authorized = await authorizedReviewer(context);
  if ("response" in authorized) return authorized.response;
  const expectedRevision = parseExpectedRevision(request);
  if (expectedRevision === null) {
    return NextResponse.json({ error: "expectedRevision is required" }, { status: 400 });
  }
  const view = await getViewForReviewer(authorized.reviewerId, authorized.userId, "test_me");
  if (!view) return NextResponse.json({ error: "Test Me is not available." }, { status: 404 });
  if (view.revision !== expectedRevision) {
    return NextResponse.json(
      { error: "This test changed elsewhere. Reload before resuming.", stale: true },
      { status: 409 },
    );
  }
  const session = await getUntimedPracticeSession({
    userId: authorized.userId,
    reviewerId: authorized.reviewerId,
    expectedRevision,
  });
  if (!session) return NextResponse.json({ session: null });
  return NextResponse.json(sessionPayload(session, expectedRevision));
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authorized = await authorizedReviewer(context);
  if ("response" in authorized) return authorized.response;

  let body: unknown;
  try {
    body = await readCappedJson(request, {
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "Practice session request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "expectedRevision is required" }, { status: 400 });
  }

  const view = await getViewForReviewer(authorized.reviewerId, authorized.userId, "test_me");
  if (!view) return NextResponse.json({ error: "Test Me is not available." }, { status: 404 });
  if (view.revision !== parsed.data.expectedRevision) {
    return NextResponse.json({ error: "This test changed elsewhere. Reload before starting.", stale: true }, { status: 409 });
  }

  if (parsed.data.intent === "retry_missed") {
    const result = await retryMissedUntimedPracticeSession({
      userId: authorized.userId,
      reviewerId: authorized.reviewerId,
      expectedRevision: parsed.data.expectedRevision,
      originSessionId: parsed.data.originSessionId,
    });
    if ("stale" in result) {
      return NextResponse.json({ error: "This test changed elsewhere. Reload before starting.", stale: true }, { status: 409 });
    }
    if ("empty" in result) {
      return NextResponse.json({ error: "There are no missed items to retry." }, { status: 409 });
    }
    if ("conflict" in result) {
      return NextResponse.json({
        error: "Another sitting is already in progress. Finish or start again before retrying misses.",
        conflict: true,
      }, { status: 409 });
    }
    if ("missing" in result || !result) {
      return NextResponse.json({ error: "Test Me is not available." }, { status: 404 });
    }
    return NextResponse.json(sessionPayload(result, parsed.data.expectedRevision));
  }

  const session = parsed.data.intent === "start_again"
    ? await restartUntimedPracticeSession({
      userId: authorized.userId,
      reviewerId: authorized.reviewerId,
      expectedRevision: parsed.data.expectedRevision,
    })
    : await createOrResumeUntimedPracticeSession({
      userId: authorized.userId,
      reviewerId: authorized.reviewerId,
      expectedRevision: parsed.data.expectedRevision,
    });
  if (!session) {
    return NextResponse.json({ error: "This test changed elsewhere. Reload before starting.", stale: true }, { status: 409 });
  }
  return NextResponse.json(sessionPayload(session, parsed.data.expectedRevision));
}
