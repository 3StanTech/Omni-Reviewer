import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { reviewCard, serializeCard } from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  rating: z.enum(["again", "good"]),
  clientRequestId: z.string().uuid().optional(),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; cardId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId, cardId } = await context.params;
  let body: unknown;
  try {
    body = await readCappedJson(request, {
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "Card review request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "rating and expectedRevision are required" }, { status: 400 });
  const result = await reviewCard({ reviewerId, userId, cardId, ...parsed.data });
  if (!result) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if ("stale" in result) return NextResponse.json({ error: "This card changed elsewhere. Reload before reviewing.", stale: true }, { status: 409 });
  return NextResponse.json({ card: serializeCard(result) });
}
