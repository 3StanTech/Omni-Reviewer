import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  createOrResumeTimedTestSession,
  getActiveTimedTestSession,
  getReviewer,
  getViewForReviewer,
  type TimedTestSessionRow,
} from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";
import {
  createTimedTestSession,
  DEFAULT_TIMED_TEST_SECONDS,
  MAX_TIMED_TEST_SECONDS,
  MIN_TIMED_TEST_SECONDS,
} from "@/lib/test-timing";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  durationSeconds: z.number().int().min(MIN_TIMED_TEST_SECONDS).max(MAX_TIMED_TEST_SECONDS).optional(),
}).strict();

function sessionResponse(row: TimedTestSessionRow, userId: string, reviewerId: string) {
  const timed = createTimedTestSession({
    userId,
    reviewerId,
    viewRevision: row.viewRevision,
    sessionId: row.id,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
  });
  return {
    sessionToken: timed.token,
    sessionId: row.id,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    durationSeconds: timed.durationSeconds,
    answeredCount: row.answeredCount,
    answeredItemIds: row.answeredItemIds,
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
  try {
    const active = await getActiveTimedTestSession({
      userId: authorized.userId,
      reviewerId: authorized.reviewerId,
      expectedRevision,
    });
    // An empty lookup is normal on the first visit. Return a successful
    // sentinel so the browser does not report an expected absence as a
    // failed network request in the console.
    if (!active) return NextResponse.json({ session: null });
    return NextResponse.json(sessionResponse(active, authorized.userId, authorized.reviewerId));
  } catch {
    return NextResponse.json({ error: "Timed Test Me is unavailable." }, { status: 503 });
  }
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
      tooLargeMessage: "Timed test request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "expectedRevision and durationSeconds are required" }, { status: 400 });
  }

  const view = await getViewForReviewer(authorized.reviewerId, authorized.userId, "test_me");
  if (!view) return NextResponse.json({ error: "Test Me is not available." }, { status: 404 });
  if (view.revision !== parsed.data.expectedRevision) {
    return NextResponse.json({ error: "This test changed elsewhere. Reload before starting.", stale: true }, { status: 409 });
  }

  try {
    const session = await createOrResumeTimedTestSession({
      userId: authorized.userId,
      reviewerId: authorized.reviewerId,
      expectedRevision: parsed.data.expectedRevision,
      durationSeconds: parsed.data.durationSeconds ?? DEFAULT_TIMED_TEST_SECONDS,
    });
    if (!session) {
      return NextResponse.json({ error: "This test changed elsewhere. Reload before starting.", stale: true }, { status: 409 });
    }
    return NextResponse.json(sessionResponse(session, authorized.userId, authorized.reviewerId));
  } catch {
    return NextResponse.json({ error: "Timed Test Me is unavailable." }, { status: 503 });
  }
}
