import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  MAX_PASTE_BODY_BYTES,
  MAX_PASTE_TEXT_CHARS,
  MAX_PASTE_TITLE_CHARS,
  normalizePasteTitle,
  normalizePasteText,
} from "@/lib/paste";
import { createSourceForOwner, getReviewer } from "@/lib/queries";
import { readCappedJson } from "@/lib/request-body";
import {
  logRedactedError,
  publicErrorMessage,
  PublicError,
} from "@/lib/public-errors";
import { serializeSource } from "@/app/api/reviewers/[id]/sources/route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const pasteSchema = z.object({
  title: z.string().max(MAX_PASTE_TITLE_CHARS + 1, "title is too long").optional(),
  text: z.string().max(MAX_PASTE_TEXT_CHARS + 1, "text is too long"),
}).strict();

type RouteContext = { params: Promise<{ id: string }> };

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
    json = await readCappedJson(request, {
      maxBytes: MAX_PASTE_BODY_BYTES,
      tooLargeMessage: "Paste request body exceeds the safe size limit",
    });
  } catch (error) {
    const message = publicErrorMessage(error, "Invalid JSON body");
    return NextResponse.json(
      { error: message },
      { status: /exceeds the safe size limit/i.test(message) ? 413 : 400 },
    );
  }

  const parsed = pasteSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  let text: string;
  try {
    text = normalizePasteText(parsed.data.text);
  } catch (error) {
    const message = publicErrorMessage(error, "Paste text is invalid");
    return NextResponse.json({ error: message }, { status: 400 });
  }

  let title: string;
  try {
    title = normalizePasteTitle(parsed.data.title ?? "Pasted notes");
  } catch (error) {
    const message = publicErrorMessage(error, "Paste title is invalid");
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    const row = await createSourceForOwner(userId, {
      reviewerId,
      filename: title,
      mime: "text/plain",
      kind: "paste",
      blobUrl: null,
      blobPathname: null,
      ingestStatus: "ready",
      extractedText: text,
      errorMessage: null,
    });

    return NextResponse.json(serializeSource(row, null), { status: 201 });
  } catch (error) {
    if (error instanceof PublicError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logRedactedError("Could not save pasted text", error, { reviewerId, userId });
    return NextResponse.json({ error: "Could not save pasted text" }, { status: 500 });
  }
}
