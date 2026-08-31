import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { isValidCardFront } from "@/lib/learning";
import { getReviewer, serializeCard, updateCard } from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  front: z.string().trim().min(1).max(20_000).optional(),
  back: z.string().trim().min(1).max(20_000).optional(),
  pinned: z.boolean().optional(),
}).strict().refine((body) => body.front !== undefined || body.back !== undefined || body.pinned !== undefined, {
  message: "front, back, or pinned is required",
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; cardId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId, cardId } = await context.params;
  if (!(await getReviewer(reviewerId, userId))) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await readCappedJson(request, {
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "Card request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  if (parsed.data.front !== undefined && !isValidCardFront(parsed.data.front)) {
    return NextResponse.json({ error: "Cloze placeholders must be balanced and nonempty" }, { status: 400 });
  }
  let row;
  try {
    row = await updateCard({ reviewerId, userId, cardId, ...parsed.data });
  } catch {
    return NextResponse.json({ error: "Invalid card content" }, { status: 400 });
  }
  if (!row) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if ("stale" in row) {
    return NextResponse.json({ error: "This card changed elsewhere. Reload before saving.", stale: true }, { status: 409 });
  }
  return NextResponse.json({ card: serializeCard(row) });
}
