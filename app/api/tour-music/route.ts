import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getTourMusicBlob } from "@/lib/blob";
import { logRedactedError } from "@/lib/public-errors";

export const dynamic = "force-dynamic";

/** One `bytes=start-end` range, the only kind passed on to Blob. */
const SINGLE_RANGE = /^bytes=(\d+-\d*|-\d+)$/;

/** Kirby's tour music, for signed-in users only (streamed from private Blob). */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Safari's audio player needs byte ranges; anything else gets the whole file.
    const requested = request.headers.get("range")?.trim() ?? "";
    const range = SINGLE_RANGE.test(requested) ? requested : undefined;
    const blob = await getTourMusicBlob(request.signal, range);
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Type": "audio/mpeg",
      "X-Content-Type-Options": "nosniff",
    });
    if (Number.isFinite(blob.blob.size)) {
      headers.set("Content-Length", String(blob.blob.size));
    }
    // The Blob SDK reports 200 for a partial read too; the upstream Content-Range marks it.
    const contentRange = range ? blob.headers.get("content-range") : null;
    if (contentRange) headers.set("Content-Range", contentRange);
    return new Response(blob.stream, { status: contentRange ? 206 : 200, headers });
  } catch (error) {
    logRedactedError("Tour music retrieval failed", error);
    return NextResponse.json({ error: "Music unavailable" }, { status: 404 });
  }
}
