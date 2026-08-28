import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import {
  createReviewer,
  getTopic,
  listReviewersByTopic,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

const createReviewerSchema = z.object({
  topicId: z.string().uuid("topicId must be a uuid"),
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

export async function GET(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const topicId = new URL(request.url).searchParams.get("topicId");
  if (!topicId) {
    return NextResponse.json(
      { error: "topicId query parameter is required" },
      { status: 400 },
    );
  }

  const topicIdParsed = z.string().uuid().safeParse(topicId);
  if (!topicIdParsed.success) {
    return NextResponse.json(
      { error: "topicId must be a uuid" },
      { status: 400 },
    );
  }

  const topic = await getTopic(topicIdParsed.data, userId);
  if (!topic) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const rows = await listReviewersByTopic(topicIdParsed.data, userId);
  return NextResponse.json(rows.map(serializeReviewer));
}

export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createReviewerSchema.safeParse(json);
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

  const topic = await getTopic(parsed.data.topicId, userId);
  if (!topic) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const row = await createReviewer(
    parsed.data.topicId,
    userId,
    parsed.data.name,
  );
  if (!row) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  return NextResponse.json(serializeReviewer(row), { status: 201 });
}
