import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
import { StudyPrintDocument } from "@/components/study-print-document";
import { loadExportData } from "@/lib/export-data";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ topicId: string; reviewerId: string }>;
  searchParams: Promise<{ kind?: string }>;
};

/** Locked In or Summary for the PDF download. Reads only; never starts or saves anything. */
export default async function StudyPrintPage({ params, searchParams }: PageProps) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/login");
  }

  const { topicId, reviewerId } = await params;
  const { kind } = await searchParams;
  if (kind !== "locked_in" && kind !== "summary") notFound();

  const data = await loadExportData({ topicId, reviewerId, userId, include: { cards: false } });
  if (!data) notFound();

  const view = kind === "summary" ? data.summary : data.lockedIn;
  return (
    <StudyPrintDocument
      modeLabel={kind === "summary" ? "Summary" : "Locked In"}
      content={view?.content ?? ""}
      annotations={view?.annotations ?? []}
    />
  );
}
