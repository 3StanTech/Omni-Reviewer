import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  handleClientUpload,
  type HandleUploadBody,
} from "@/lib/blob";
import {
  logRedactedError,
  publicErrorMessage,
} from "@/lib/public-errors";
import {
  cappedBodyError,
  MAX_UPLOAD_HANDSHAKE_BODY_BYTES,
  readCappedJson,
} from "@/lib/request-body";

export const dynamic = "force-dynamic";

const handleUploadBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("blob.generate-client-token"),
    payload: z.object({
      pathname: z.string().min(1).max(1000),
      multipart: z.boolean(),
      clientPayload: z.string().max(20_000).nullable(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("blob.upload-completed"),
    payload: z.object({
      blob: z.record(z.string(), z.unknown()),
      tokenPayload: z.string().max(20_000).nullable().optional(),
    }).strict(),
  }).strict(),
]);

/**
 * Client-upload token + Blob completion callback.
 * Token requests require a session. onUploadCompleted is a no-op; source rows
 * are created later via POST /api/reviewers/[id]/sources (session-gated).
 * proxy.ts exempts this POST path so Blob's token-verified callback can land.
 */
export async function POST(request: Request) {
  let parsedBody: unknown;
  try {
    parsedBody = await readCappedJson(request, {
      maxBytes: MAX_UPLOAD_HANDSHAKE_BODY_BYTES,
      tooLargeMessage: "Blob upload request body exceeds the safe size limit",
    });
  } catch (error) {
    const { message, status } = cappedBodyError(error);
    return NextResponse.json({ error: message }, { status });
  }
  const parsed = handleUploadBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid Blob upload request" }, { status: 400 });
  }
  const body = parsed.data as HandleUploadBody;

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
    const message = publicErrorMessage(err, "Blob upload handshake failed");
    if (message === "Blob upload handshake failed") {
      logRedactedError("Blob upload handshake failed", err);
    }
    if (/unauthorized/i.test(message)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      /pathname|mime|content type|not allowed|clientPayload/i.test(message)
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Blob upload handshake failed" },
      { status: 400 },
    );
  }
}
