import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { listQueuedPacks } from "@/lib/queries";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** The session user's queued packs, oldest first. Never calls a model. */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const packs = await listQueuedPacks(userId);
  return NextResponse.json(
    {
      packs: packs.map((pack) => ({
        id: pack.id,
        topicId: pack.topicId,
        name: pack.name,
        queuedAt: pack.queuedAt.toISOString(),
        ready: pack.ready,
        reason: pack.ready ? null : "no_ready_source",
        activeJobId: pack.activeJobId,
        failed: pack.failed,
        lastError: pack.lastError,
      })),
    },
    { headers: NO_STORE },
  );
}
