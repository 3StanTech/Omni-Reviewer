import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { deleteBlobIfUnreferenced } from "@/lib/blob";
import {
  beginReviewerDeletion,
  deleteReviewer,
  getReviewer,
  listBlobReservationsForReviewer,
  listSourcesByReviewer,
  markSourcesDeletingForReviewer,
  renameReviewer,
} from "@/lib/queries";
import { logRedactedError } from "@/lib/public-errors";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

const renameReviewerSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
}).strict();

function serializeReviewer(row: {
  id: string;
  topicId: string;
  name: string;
  createdAt: Date;
  lastGeneratedAt: Date | null;
  examDate: string | null;
}) {
  return {
    id: row.id,
    topicId: row.topicId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastGeneratedAt: row.lastGeneratedAt
      ? row.lastGeneratedAt.toISOString()
      : null,
    examDate: row.examDate,
  };
}

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  let json: unknown;
  try {
    json = await readCappedJson(request, {
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "Reviewer request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }

  const parsed = renameReviewerSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const existing = await getReviewer(id, userId);
  if (!existing) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const row = await renameReviewer(id, userId, parsed.data.name);
  if (!row) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  return NextResponse.json(serializeReviewer(row));
}

export async function DELETE(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const marked = await beginReviewerDeletion(id, userId);
  if (!marked) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  try {
    await markSourcesDeletingForReviewer(id, userId);
    const sources = await listSourcesByReviewer(id, userId);
    const reservations = await listBlobReservationsForReviewer(id, userId);
    const pathnames = new Set<string>([
      ...sources.flatMap((source) => source.blobPathname ? [source.blobPathname] : []),
      ...reservations.map((reservation) => reservation.pathname),
    ]);
    const deleted = await Promise.all(
      [...pathnames].map((pathname) =>
        deleteBlobIfUnreferenced(
          pathname,
          { userId, reviewerId: id },
          { allowDeletingSource: true, abortSignal: request.signal },
        ),
      ),
    );
    if (deleted.some((ok) => !ok)) {
      // Keep the durable deletion tombstone. A later retry can reclaim an
      // expired lease while source creation remains blocked in the meantime.
      return NextResponse.json(
        { error: "Could not remove all source files. Try again." },
        { status: 503 },
      );
    }
    const row = await deleteReviewer(id, userId);
    if (!row) {
      return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, id: row.id });
  } catch (error) {
    logRedactedError("Reviewer deletion failed", error, { reviewerId: id, userId });
    return NextResponse.json({ error: "Could not delete reviewer" }, { status: 500 });
  }
}
