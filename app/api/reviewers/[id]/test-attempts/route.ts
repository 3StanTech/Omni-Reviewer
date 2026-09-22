import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  getReviewer,
  listTestAttemptStats,
  recordTestAttempts,
  recordTimedTestAttempt,
  recordUntimedTestAttempt,
} from "@/lib/queries";
import {
  cappedBodyError,
  MAX_TEST_ATTEMPT_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";
import { verifyTimedTestSession } from "@/lib/test-timing";

export const dynamic = "force-dynamic";

const legacyBodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  answers: z.array(z.object({
    itemId: z.string().min(1).max(200),
    selectedAnswer: z.string().min(1).max(20_000),
  }).strict()).min(1).max(100),
}).strict();

const timedBodySchema = z.object({
  mode: z.literal("timed"),
  expectedRevision: z.number().int().positive(),
  sessionToken: z.string().min(32).max(4096),
  itemId: z.string().min(1).max(200),
  selectedAnswer: z.string().min(1).max(20_000),
}).strict();

const untimedBodySchema = z.object({
  mode: z.literal("untimed"),
  expectedRevision: z.number().int().positive(),
  sessionId: z.string().uuid(),
  itemId: z.string().min(1).max(200),
  selectedAnswer: z.string().min(1).max(20_000),
}).strict();

const bodySchema = z.union([legacyBodySchema, timedBodySchema, untimedBodySchema]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId } = await context.params;
  if (!(await getReviewer(reviewerId, userId))) return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  return NextResponse.json({ stats: await listTestAttemptStats(reviewerId, userId) });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId } = await context.params;
  if (!(await getReviewer(reviewerId, userId))) return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  let body: unknown;
  try {
    body = await readCappedJson(request, {
      maxBytes: MAX_TEST_ATTEMPT_BODY_BYTES,
      tooLargeMessage: "Test attempt request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "answers and expectedRevision are required" }, { status: 400 });
  try {
    if ("mode" in parsed.data && parsed.data.mode === "untimed") {
      const result = await recordUntimedTestAttempt({
        reviewerId,
        userId,
        sessionId: parsed.data.sessionId,
        expectedRevision: parsed.data.expectedRevision,
        itemId: parsed.data.itemId,
        selectedAnswer: parsed.data.selectedAnswer,
      });
      if ("stale" in result) return NextResponse.json({ error: "This test changed elsewhere. Reload before saving.", stale: true }, { status: 409 });
      if ("missing" in result) return NextResponse.json({ error: "Test Me is not available." }, { status: 404 });
      if ("invalid" in result) {
        return NextResponse.json({ error: "This question is not part of the current sitting." }, { status: 400 });
      }
      if ("conflict" in result) {
        return NextResponse.json({ error: "This answer was already saved in another tab.", conflict: true }, { status: 409 });
      }
      return NextResponse.json(result);
    }

    if ("mode" in parsed.data) {
      const verification = verifyTimedTestSession(parsed.data.sessionToken);
      if (!verification.ok) {
        return NextResponse.json(
          {
            error: verification.reason === "expired"
              ? "This timed run has ended. Start a new run."
              : "Invalid timed test session.",
            expired: verification.reason === "expired",
          },
          { status: 409 },
        );
      }
      if (
        verification.claims.userId !== userId ||
        verification.claims.reviewerId !== reviewerId ||
        verification.claims.viewRevision !== parsed.data.expectedRevision
      ) {
        return NextResponse.json({ error: "This timed run does not belong to this test." }, { status: 409 });
      }
      const result = await recordTimedTestAttempt({
        reviewerId,
        userId,
        sessionId: verification.claims.sessionId,
        expectedRevision: parsed.data.expectedRevision,
        itemId: parsed.data.itemId,
        selectedAnswer: parsed.data.selectedAnswer,
      });
      if ("stale" in result) return NextResponse.json({ error: "This test changed elsewhere. Reload before saving.", stale: true }, { status: 409 });
      if ("missing" in result) return NextResponse.json({ error: "Test Me is not available." }, { status: 404 });
      if ("expired" in result) {
        return NextResponse.json({ error: "This timed run has ended. Start a new run.", expired: true }, { status: 409 });
      }
      if ("conflict" in result) {
        return NextResponse.json({ error: "This answer was already saved in another tab.", conflict: true }, { status: 409 });
      }
      return NextResponse.json(result);
    }

    const result = await recordTestAttempts({ reviewerId, userId, ...parsed.data });
    if ("stale" in result) return NextResponse.json({ error: "This test changed elsewhere. Reload before saving.", stale: true }, { status: 409 });
    if ("missing" in result) return NextResponse.json({ error: "Test Me is not available." }, { status: 404 });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Unable to save this attempt." }, { status: 400 });
  }
}
