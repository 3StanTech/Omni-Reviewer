import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  isAllowedMime,
  kindFromMime,
  normalizeMime,
} from "@/lib/blob";
import { ingestSource } from "@/lib/ingest";
import {
  createSource,
  getReviewer,
  listSourcesForUi,
} from "@/lib/queries";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const createSourceSchema = z.object({
  filename: z.string().trim().min(1, "filename is required").max(500),
  mime: z.string().trim().min(1, "mime is required").max(200),
  blob_url: z.string().url("blob_url must be a valid url"),
  blob_pathname: z.string().trim().min(1, "blob_pathname is required").max(1000),
});

function serializeSource(row: {
  id: string;
  reviewerId: string;
  filename: string;
  mime: string;
  kind: string;
  blobUrl: string;
  blobPathname: string;
  ingestStatus: string;
  errorMessage: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    reviewerId: row.reviewerId,
    filename: row.filename,
    mime: row.mime,
    kind: row.kind,
    blob_url: row.blobUrl,
    blob_pathname: row.blobPathname,
    blobUrl: row.blobUrl,
    blobPathname: row.blobPathname,
    ingest_status: row.ingestStatus,
    ingestStatus: row.ingestStatus,
    error_message: row.errorMessage,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  };
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const rows = await listSourcesForUi(reviewerId, userId);
  return NextResponse.json(rows.map(serializeSource));
}

export async function POST(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: reviewerId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createSourceSchema.safeParse(json);
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

  const mime = normalizeMime(parsed.data.mime);
  if (!isAllowedMime(mime)) {
    return NextResponse.json(
      { error: `Unsupported mime type: ${parsed.data.mime}` },
      { status: 400 },
    );
  }

  const kind = kindFromMime(mime);
  if (!kind) {
    return NextResponse.json(
      { error: `Unsupported mime type: ${parsed.data.mime}` },
      { status: 400 },
    );
  }

  const expectedPrefix = `users/${userId}/reviewers/${reviewerId}/`;
  if (!parsed.data.blob_pathname.startsWith(expectedPrefix)) {
    return NextResponse.json(
      {
        error: `blob_pathname must be under ${expectedPrefix}`,
      },
      { status: 400 },
    );
  }

  const ingest = await ingestSource({
    mime,
    blobUrl: parsed.data.blob_url,
    filename: parsed.data.filename,
  });

  // Prefer kind from mime classification; ingest echoes the same kind.
  const row = await createSource({
    reviewerId,
    filename: parsed.data.filename,
    mime,
    kind,
    blobUrl: parsed.data.blob_url,
    blobPathname: parsed.data.blob_pathname,
    ingestStatus: ingest.ingestStatus,
    extractedText: ingest.extractedText,
    errorMessage: ingest.errorMessage,
  });

  return NextResponse.json(serializeSource(row), { status: 201 });
}
