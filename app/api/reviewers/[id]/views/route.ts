import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getReviewer } from "@/lib/queries";
import { views } from "@/lib/schema";
import { viewsPayloadFromRows } from "@/lib/serialize-view";

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

  const rows = await db
    .select()
    .from(views)
    .where(eq(views.reviewerId, reviewerId));

  return NextResponse.json(viewsPayloadFromRows(rows));
}
