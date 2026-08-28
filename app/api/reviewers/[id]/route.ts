import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  deleteReviewer,
  getReviewer,
  renameReviewer,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

const renameReviewerSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
});

function serializeReviewer(row: {
  id: string;
  topicId: string;
  name: string;
  createdAt: Date;
  lastGeneratedAt: Date | null;
}) {
  return {
    id: row.id,
    topicId: row.topicId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastGeneratedAt: row.lastGeneratedAt
      ? row.lastGeneratedAt.toISOString()
      : null,
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
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const row = await deleteReviewer(id, userId);
  if (!row) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: row.id });
}
