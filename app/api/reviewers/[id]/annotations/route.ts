import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  annotationDraftSchema,
  DEFAULT_EARLIER_ANNOTATION_PAGE_SIZE,
  MAX_ACTIVE_ANNOTATIONS,
  validateAnnotationBatch,
} from "@/lib/annotations";
import {
  getReviewer,
  getViewForReviewer,
  listAnnotationPageForReviewer,
  saveAnnotations,
} from "@/lib/queries";
import {
  cappedBodyError,
  MAX_MUTATION_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

const kindSchema = z.enum(["locked_in", "summary"]);
const bodySchema = z.object({
  kind: kindSchema,
  expectedRevision: z.number().int().positive(),
  expectedContentRevision: z.number().int().positive(),
  expectedAnnotationRevision: z.number().int().positive(),
  annotations: z.array(annotationDraftSchema).min(1).max(MAX_ACTIVE_ANNOTATIONS),
}).strict();

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId } = await context.params;
  if (!(await getReviewer(reviewerId, userId))) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }
  const kindParam = new URL(request.url).searchParams.get("kind");
  const kind = kindParam ? kindSchema.safeParse(kindParam) : null;
  if (kindParam && !kind?.success) {
    return NextResponse.json({ error: "Invalid annotation kind" }, { status: 400 });
  }
  const requestedKind = kind?.success ? kind.data : undefined;
  const scope = new URL(request.url).searchParams.get("scope");
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  if (scope === "earlier") {
    if (!requestedKind) return NextResponse.json({ error: "kind is required for Earlier version history" }, { status: 400 });
    const page = await listAnnotationPageForReviewer(reviewerId, userId, requestedKind, {
      earlierOnly: true,
      cursor,
      limit: DEFAULT_EARLIER_ANNOTATION_PAGE_SIZE,
    });
    return NextResponse.json(page);
  }
  if (requestedKind) {
    return NextResponse.json(await listAnnotationPageForReviewer(reviewerId, userId, requestedKind, {
      limit: DEFAULT_EARLIER_ANNOTATION_PAGE_SIZE,
    }));
  }
  const [lockedIn, summary] = await Promise.all([
    listAnnotationPageForReviewer(reviewerId, userId, "locked_in"),
    listAnnotationPageForReviewer(reviewerId, userId, "summary"),
  ]);
  return NextResponse.json({
    annotations: [...lockedIn.annotations, ...summary.annotations],
    nextCursor: null,
    nextCursors: { locked_in: lockedIn.nextCursor, summary: summary.nextCursor },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId } = await context.params;
  if (!(await getReviewer(reviewerId, userId))) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }
  let json: unknown;
  try {
    json = await readCappedJson(request, {
      maxBytes: MAX_MUTATION_BODY_BYTES,
      tooLargeMessage: "Annotation request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid annotation request" },
      { status: 400 },
    );
  }

  const view = await getViewForReviewer(reviewerId, userId, parsed.data.kind);
  if (!view) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if (
    view.revision !== parsed.data.expectedRevision ||
    view.contentRevision !== parsed.data.expectedContentRevision ||
    view.annotationRevision !== parsed.data.expectedAnnotationRevision
  ) {
    return NextResponse.json(
      { error: "This document changed elsewhere. Reload before saving.", stale: true },
      { status: 409 },
    );
  }
  const validated = validateAnnotationBatch(view.content, parsed.data.annotations);
  if (!validated) {
    return NextResponse.json(
      { error: "The selected text no longer matches this document. Select it again." },
      { status: 409 },
    );
  }
  const saved = await saveAnnotations({
    reviewerId,
    userId,
    kind: parsed.data.kind,
    expectedRevision: parsed.data.expectedRevision,
    expectedContentRevision: parsed.data.expectedContentRevision,
    expectedAnnotationRevision: parsed.data.expectedAnnotationRevision,
    items: validated,
  });
  if (!saved) {
    return NextResponse.json(
      { error: "Annotations changed or the active annotation limit was reached. Reload and try again.", stale: true },
      { status: 409 },
    );
  }
  const page = await listAnnotationPageForReviewer(reviewerId, userId, parsed.data.kind, {
    earlierOnly: false,
    limit: DEFAULT_EARLIER_ANNOTATION_PAGE_SIZE,
  });
  return NextResponse.json({ ...saved, ...page });
}
