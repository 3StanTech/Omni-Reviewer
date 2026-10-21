import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
import { PacketDocument } from "@/components/packet-document";
import { loadExportData } from "@/lib/export-data";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ topicId: string; reviewerId: string }>;
};

/** The study packet for the PDF download. Reads only; never backfills cards. */
export default async function StudyPacketPage({ params }: PageProps) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/login");
  }

  const { topicId, reviewerId } = await params;

  const data = await loadExportData({ topicId, reviewerId, userId, include: { cards: true } });
  if (!data) notFound();

  const generatedOn = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "Asia/Manila",
  }).format(new Date());

  return (
    <PacketDocument
      packName={data.packName}
      topicName={data.topicName}
      generatedOn={generatedOn}
      lockedIn={data.lockedIn?.content ?? ""}
      summary={data.summary?.content ?? ""}
      cards={data.cards}
    />
  );
}
