import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { PdfSignedOutError, renderPdf } from "@/lib/pdf";
import { logRedactedError } from "@/lib/public-errors";
import { getReviewer } from "@/lib/queries";
import { exportFilename } from "@/lib/study-export";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const querySchema = z.object({
  kind: z.enum(["locked_in", "summary", "packet"]),
  citations: z.enum(["on", "off"]).default("on"),
  notes: z.enum(["on", "off"]).default("on"),
});

const KIND_LABELS = { locked_in: "Locked In", summary: "Summary", packet: "Study packet" } as const;

/** Download Locked In, Summary or the study packet as a PDF file. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: reviewerId } = await context.params;
  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer || reviewer.deletingAt) {
    return NextResponse.json({ error: "Reviewer not found" }, { status: 404 });
  }

  const requestUrl = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(requestUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "kind must be locked_in, summary or packet" }, { status: 400 });
  }
  const { kind, citations, notes } = parsed.data;

  const packPath = `/topics/${reviewer.topicId}/reviewers/${reviewer.id}`;
  const url = new URL(kind === "packet" ? `${packPath}/packet` : `${packPath}?mode=${kind}`, requestUrl.origin);
  const bodyData = kind === "packet" ? undefined : { exportCitations: citations, exportAnnotations: notes };

  try {
    const pdf = await renderPdf({ url, cookieHeader: request.headers.get("cookie"), bodyData });
    const filename = exportFilename(reviewer.name, KIND_LABELS[kind], ".pdf");
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof PdfSignedOutError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    logRedactedError("PDF export failed", error, { reviewerId });
    return NextResponse.json({ error: "Could not make the PDF. Try again." }, { status: 500 });
  }
}
