import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { readFreeRequestQuota } from "@/lib/openrouter-quota";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const quota = await readFreeRequestQuota({ fresh });
  return NextResponse.json(
    quota ? { remaining: quota.remaining, limit: quota.limit } : { remaining: null, limit: null },
    { headers: NO_STORE },
  );
}
