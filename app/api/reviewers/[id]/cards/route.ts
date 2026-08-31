import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getCardsForReviewer, getReviewer, serializeCard } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId } = await context.params;
  if (!(await getReviewer(reviewerId, userId))) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }
  const cards = await getCardsForReviewer(reviewerId, userId);
  return NextResponse.json({ cards: cards.map(serializeCard) });
}
