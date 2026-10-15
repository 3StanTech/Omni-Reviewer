import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getTodayPlan } from "@/lib/queries";
import { reviewers, testSessions, topics } from "@/lib/schema";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

/** First-time facts for the session user only; every query is scoped to that id. */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const [[generated], [sittings], today] = await Promise.all([
    db
      .select({ value: count() })
      .from(reviewers)
      .innerJoin(topics, eq(reviewers.topicId, topics.id))
      .where(
        and(
          eq(topics.userId, userId),
          isNull(topics.deletingAt),
          isNull(reviewers.deletingAt),
          isNotNull(reviewers.lastGeneratedAt),
        ),
      ),
    db
      .select({ value: count() })
      .from(testSessions)
      .where(and(eq(testSessions.userId, userId), eq(testSessions.status, "completed"))),
    getTodayPlan(userId),
  ]);

  const bar = today?.plan.bar;
  return NextResponse.json(
    {
      generatedPacks: generated?.value ?? 0,
      completedSittings: sittings?.value ?? 0,
      dueToday: bar ? bar.reviewCards + bar.newCards : 0,
    },
    { headers: NO_STORE },
  );
}
