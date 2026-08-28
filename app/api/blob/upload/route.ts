import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  handleClientUpload,
  type HandleUploadBody,
} from "@/lib/blob";

export const dynamic = "force-dynamic";

/**
 * Client-upload token + Blob completion callback.
 * Token requests require a session. onUploadCompleted is a no-op; source rows
 * are created later via POST /api/reviewers/[id]/sources (session-gated).
 * proxy.ts exempts this POST path so Blob's token-verified callback can land.
 */
export async function POST(request: Request) {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let userId: string | null = null;
  if (body.type === "blob.generate-client-token") {
    const session = await auth();
    userId = session?.user?.id ?? null;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await handleClientUpload({ request, body, userId });
    return NextResponse.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Blob upload handshake failed";
    if (/unauthorized/i.test(message)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      /pathname|mime|content type|not allowed|clientPayload/i.test(message)
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
