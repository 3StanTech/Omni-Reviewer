import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { getReviewer, setReviewerQueued } from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

/** `requeue` (Retry) stamps a new queue time so a stopped run can run again. */
const bodySchema = z.object({ queued: z.boolean(), requeue: z.boolean().optional() }).strict();

/** Queue or dequeue a pack for generation on the Study desk. */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer || reviewer.deletingAt) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await readCappedJson(request, {
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "Queue request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "queued must be true or false" }, { status: 400 });
  }
  const row = await setReviewerQueued(
    reviewerId,
    userId,
    parsed.data.queued,
    parsed.data.queued && parsed.data.requeue === true,
  );
  if (!row) return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  return NextResponse.json({ queuedAt: row.queuedAt ? row.queuedAt.toISOString() : null });
}
