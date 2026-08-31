import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { getReviewer, updateStudyView } from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  expectedRevision: z.number().int().positive(),
  content: z.string().trim().min(1).max(500_000).optional(),
  pinned: z.boolean().optional(),
}).strict().refine((body) => body.content !== undefined || body.pinned !== undefined, {
  message: "content or pinned is required",
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; kind: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId, kind } = await context.params;
  if (kind !== "locked_in") {
    return NextResponse.json({ error: "Only Locked In can be edited here." }, { status: 400 });
  }
  if (!(await getReviewer(reviewerId, userId))) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }
  let parsedJson: unknown;
  try {
    parsedJson = await readCappedJson(request, {
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "View request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(parsedJson);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const row = await updateStudyView({ reviewerId, userId, kind, ...parsed.data });
  if (!row) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if ("stale" in row) {
    return NextResponse.json(
      { error: "This view changed elsewhere. Reload before saving.", stale: true },
      { status: 409 },
    );
  }
  return NextResponse.json({
    view: {
      id: row.id,
      revision: row.revision,
      content: row.content,
      isEdited: row.isEdited,
      isPinned: row.isPinned,
      updatedAt: row.updatedAt.toISOString(),
    },
    staleKinds: ["summary", "test_me", "carded"],
  });
}
