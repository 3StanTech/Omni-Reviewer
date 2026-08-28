import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { createTopic, listTopics } from "@/lib/queries";

export const dynamic = "force-dynamic";

const createTopicSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
});

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

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await listTopics(userId);
  return NextResponse.json(rows.map(serializeTopic));
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

  const parsed = createTopicSchema.safeParse(json);
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

  const row = await createTopic(userId, parsed.data.name);
  return NextResponse.json(serializeTopic(row), { status: 201 });
}
