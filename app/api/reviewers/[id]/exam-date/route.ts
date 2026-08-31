import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { getReviewer, updateReviewerExamDate } from "@/lib/queries";
import { isCalendarDate } from "@/lib/date-validation";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  examDate: z.string().refine(isCalendarDate, "examDate must be a real calendar date").nullable(),
}).strict();

export async function PATCH(
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
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "Exam-date request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "examDate must be YYYY-MM-DD or null" }, { status: 400 });
  const reviewer = await updateReviewerExamDate(reviewerId, userId, parsed.data.examDate);
  if (!reviewer) return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  return NextResponse.json({ examDate: reviewer.examDate });
}
