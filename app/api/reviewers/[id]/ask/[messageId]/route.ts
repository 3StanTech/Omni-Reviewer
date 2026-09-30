import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { getReviewer } from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";
import { setSaved, toChatMessageDto } from "@/lib/tutor-queries";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ saved: z.boolean() }).strict();

/** Save an answer to Notes or remove it. Only the owner's non-refused answers can be saved. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId, messageId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer || reviewer.deletingAt) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }
  let json: unknown;
  try {
    json = await readCappedJson(request, {
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "Message request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const row = await setSaved(messageId, reviewerId, userId, parsed.data.saved);
  if (!row) return NextResponse.json({ error: "Answer not found" }, { status: 404 });
  return NextResponse.json({ message: toChatMessageDto(row) });
}
