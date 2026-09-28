import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { regroundStudyDocument } from "@/lib/ai";
import { readStudyDocumentMeta } from "@/lib/citations";
import { classifyGenerationError } from "@/lib/generation-errors";
import { loadGenerationViews } from "@/lib/generation-jobs";
import { logRedactedError } from "@/lib/public-errors";
import {
  getReviewer,
  getViewForReviewer,
  listAnnotationPageForReviewer,
  loadGroundingSources,
  updateStudyView,
} from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";
// Up to two verifier calls on a free model.
export const maxDuration = 300;

const bodySchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict();

/**
 * Re-check a study document's claims that an earlier grounding run could not
 * verify. Adding unsourced tags this way is not a reader edit.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; kind: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId, kind } = await context.params;
  if (kind !== "locked_in" && kind !== "summary") {
    return NextResponse.json({ error: "Only study documents can be checked." }, { status: 400 });
  }
  if (!(await getReviewer(reviewerId, userId))) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }
  let parsedJson: unknown;
  try {
    parsedJson = await readCappedJson(request, {
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "Check request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(parsedJson);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });

  const view = await getViewForReviewer(reviewerId, userId, kind);
  if (!view?.content?.trim()) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if (view.revision !== parsed.data.expectedRevision) {
    return NextResponse.json(
      { error: "This view changed elsewhere. Reload before checking.", stale: true },
      { status: 409 },
    );
  }
  const citationSources = readStudyDocumentMeta(view.contentJson)?.citationSources ?? [];
  const groundingSources = await loadGroundingSources(reviewerId, citationSources);
  if (groundingSources.length === 0) {
    return NextResponse.json({ error: "This document has no sources to check against." }, { status: 400 });
  }

  let regrounded: Awaited<ReturnType<typeof regroundStudyDocument>>;
  try {
    regrounded = await regroundStudyDocument(view.content, groundingSources);
  } catch (error) {
    logRedactedError("Grounding re-check failed", error, { reviewerId });
    const classified = classifyGenerationError(error);
    return NextResponse.json({ error: classified.message }, { status: 502 });
  }
  if (!regrounded.report) {
    return NextResponse.json({ error: "This document has no sources to check against." }, { status: 400 });
  }

  const row = await updateStudyView({
    reviewerId,
    userId,
    kind,
    expectedRevision: parsed.data.expectedRevision,
    content: regrounded.markdown,
    grounding: regrounded.report,
  });
  if (!row) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if ("stale" in row) {
    return NextResponse.json(
      { error: "This view changed elsewhere. Reload before checking.", stale: true },
      { status: 409 },
    );
  }
  const annotationPage = await listAnnotationPageForReviewer(reviewerId, userId, kind, { limit: 50 });
  const viewsPayload = await loadGenerationViews(reviewerId, { userId });
  return NextResponse.json({
    grounding: regrounded.report,
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
