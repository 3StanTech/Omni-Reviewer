import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { loadGenerationViews } from "@/lib/generation-jobs";
import { isPublicError } from "@/lib/public-errors";
import { getReviewer, listAnnotationPageForReviewer, updateStudyView } from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";
import { studyMarkdownProblem } from "@/lib/study-markdown";

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
  if (kind !== "locked_in" && kind !== "summary") {
    return NextResponse.json({ error: "Only study documents can be edited here." }, { status: 400 });
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
  if (kind === "summary" && parsed.data.pinned !== undefined) {
    return NextResponse.json({ error: "Summary does not support pinning." }, { status: 400 });
  }
  // The reader refuses content past its render limits, so never save what it cannot show.
  const renderProblem = parsed.data.content === undefined ? null : studyMarkdownProblem(parsed.data.content);
  if (renderProblem) return NextResponse.json({ error: renderProblem }, { status: 400 });
  // The persistence guard re-checks what is stored, which can differ from the body after normalization.
  let row: Awaited<ReturnType<typeof updateStudyView>>;
  try {
    row = await updateStudyView({
      reviewerId,
      userId,
      kind,
      ...parsed.data,
    });
  } catch (error) {
    if (isPublicError(error)) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  if (!row) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if ("stale" in row) {
    return NextResponse.json(
      { error: "This view changed elsewhere. Reload before saving.", stale: true },
      { status: 409 },
    );
  }
  const annotationPage = kind === "locked_in" || kind === "summary"
    ? await listAnnotationPageForReviewer(reviewerId, userId, kind, { limit: 50 })
    : { annotations: [], nextCursor: null };
  const viewsPayload = await loadGenerationViews(reviewerId, { userId });
  return NextResponse.json({
    view: {
      id: row.id,
      revision: row.revision,
      contentRevision: row.contentRevision,
      annotationRevision: row.annotationRevision,
      content: row.content,
      isEdited: row.isEdited,
      isPinned: row.isPinned,
      updatedAt: row.updatedAt.toISOString(),
      annotations: annotationPage.annotations,
      annotationsNextCursor: annotationPage.nextCursor,
    },
    staleKinds: viewsPayload.staleKinds ?? [],
  });
}
