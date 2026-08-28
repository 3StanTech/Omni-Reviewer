import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { deleteBlob } from "@/lib/blob";
import {
  deleteSource,
  getReviewer,
  getSourceForReviewer,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string; sourceId: string }>;
};

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId, sourceId } = await context.params;

  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const source = await getSourceForReviewer(reviewerId, sourceId, userId);
  if (!source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  // Best-effort blob cleanup before row delete.
  await deleteBlob(source.blobUrl);
  if (source.blobPathname && source.blobPathname !== source.blobUrl) {
    await deleteBlob(source.blobPathname);
  }

  const deleted = await deleteSource(sourceId);
  if (!deleted) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: deleted.id });
}
