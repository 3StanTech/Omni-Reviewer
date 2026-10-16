import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { readFreeRequestState } from "@/lib/free-request-ledger";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return NextResponse.json(await readFreeRequestState({ fresh }), { headers: NO_STORE });
}
