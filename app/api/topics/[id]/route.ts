import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { deleteBlobIfUnreferenced } from "@/lib/blob";
import {
  beginTopicDeletion,
  deleteTopic,
  getTopic,
  listBlobReservationsForReviewer,
  listReviewersByTopic,
  listSourcesByReviewer,
  markSourcesDeletingForTopic,
  renameTopic,
} from "@/lib/queries";
import { logRedactedError } from "@/lib/public-errors";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

const renameTopicSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
}).strict();

function serializeTopic(row: {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
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
      tooLargeMessage: "Topic request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }

  const parsed = renameTopicSchema.safeParse(json);
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

  const existing = await getTopic(id, userId);
  if (!existing) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const row = await renameTopic(id, userId, parsed.data.name);
  if (!row) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  return NextResponse.json(serializeTopic(row));
}

export async function DELETE(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const marked = await beginTopicDeletion(id, userId);
  if (!marked) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  try {
    await markSourcesDeletingForTopic(id, userId);
    const reviewers = await listReviewersByTopic(id, userId);
    const sources = (
      await Promise.all(
        reviewers.map((reviewer) => listSourcesByReviewer(reviewer.id, userId)),
      )
    ).flat();
    const pathnamesByReviewer = await Promise.all(
      reviewers.map(async (reviewer) => ({
        reviewerId: reviewer.id,
        pathnames: new Set<string>([
          ...(sources
            .filter((source) => source.reviewerId === reviewer.id && source.blobPathname)
            .map((source) => source.blobPathname!) ?? []),
          ...(await listBlobReservationsForReviewer(reviewer.id, userId)).map(
            (reservation) => reservation.pathname,
          ),
        ]),
      })),
    );
    const deleted = await Promise.all(
      pathnamesByReviewer.flatMap(({ reviewerId, pathnames }) =>
        [...pathnames].map((pathname) =>
          deleteBlobIfUnreferenced(
            pathname,
            { userId, reviewerId },
            { allowDeletingSource: true, abortSignal: request.signal },
          ),
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
    const row = await deleteTopic(id, userId);
    if (!row) {
      return NextResponse.json({ error: "Topic not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, id: row.id });
  } catch (error) {
    logRedactedError("Topic deletion failed", error, { topicId: id, userId });
    return NextResponse.json({ error: "Could not delete topic" }, { status: 500 });
  }
}
