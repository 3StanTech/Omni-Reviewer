import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { loadGenerationViews } from "@/lib/generation-jobs";
import { getReviewer } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * Side-effect free: returns persisted views only. Does not call the model.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId } = await context.params;

  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  return NextResponse.json(await loadGenerationViews(reviewerId, { userId }));
}
