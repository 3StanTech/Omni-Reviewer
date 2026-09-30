import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { isValidCardFront } from "@/lib/learning";
import { MAX_CARD_BACK_CHARS, MAX_CARD_FRONT_CHARS } from "@/lib/learning-limits";
import { isPublicError } from "@/lib/public-errors";
import { getReviewer } from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";
import { createCardFromMessage } from "@/lib/tutor-queries";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  front: z.string().trim().min(1, "Card front is required.").max(
    MAX_CARD_FRONT_CHARS,
    `Card front can be at most ${MAX_CARD_FRONT_CHARS.toLocaleString()} characters.`,
  ),
  back: z.string().trim().min(1, "Card back is required.").max(
    MAX_CARD_BACK_CHARS,
    `Card back can be at most ${MAX_CARD_BACK_CHARS.toLocaleString()} characters.`,
  ),
}).strict();

/** Make a user-authored card from an answer. A repeat returns the same card. */
export async function POST(
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
      tooLargeMessage: "Card request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  if (!isValidCardFront(parsed.data.front)) {
    return NextResponse.json({ error: "Cloze placeholders must be balanced and nonempty" }, { status: 400 });
  }
  let result;
  try {
    result = await createCardFromMessage({ messageId, reviewerId, userId, ...parsed.data });
  } catch (error) {
    if (isPublicError(error)) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  if (!result) return NextResponse.json({ error: "Answer not found" }, { status: 404 });
  return NextResponse.json({ created: result.created, cardId: result.card.id });
}
