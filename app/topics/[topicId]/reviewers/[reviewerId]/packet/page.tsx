import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
import { PacketDocument, type PacketCard } from "@/components/packet-document";
import { getCardsForReviewer, getReviewer, getTopic, getViewForReviewer } from "@/lib/queries";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ topicId: string; reviewerId: string }>;
};

export default async function StudyPacketPage({ params }: PageProps) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/login");
  }

  const { topicId, reviewerId } = await params;

  const topic = await getTopic(topicId, userId);
  if (!topic) notFound();

  const reviewer = await getReviewer(reviewerId, userId);
  if (!reviewer || reviewer.topicId !== topicId) notFound();

  const [lockedIn, summary, cards] = await Promise.all([
    getViewForReviewer(reviewerId, userId, "locked_in"),
    getViewForReviewer(reviewerId, userId, "summary"),
    getCardsForReviewer(reviewerId, userId),
  ]);

  const packetCards: PacketCard[] = cards.map((card) => ({
    id: card.id,
    front: card.front,
    back: card.back,
  }));

  const generatedOn = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "Asia/Manila",
  }).format(new Date());

  return (
    <PacketDocument
      packName={reviewer.name}
      topicName={topic.name}
      generatedOn={generatedOn}
      lockedIn={lockedIn?.content ?? ""}
      summary={summary?.content ?? ""}
      cards={packetCards}
    />
  );
}
