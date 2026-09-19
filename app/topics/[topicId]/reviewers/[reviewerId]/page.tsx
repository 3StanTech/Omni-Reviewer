import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
import { AppShell } from "@/components/app-shell";
import type { ViewsPayload } from "@/components/generate-button";
import { ReviewerWorkspace } from "@/components/reviewer-workspace";
import type { SourceListItem } from "@/components/source-panel";
import {
  getReviewer,
  getCardsForReviewer,
  getTopic,
  listReviewersByTopic,
  listTestAttemptStats,
  listSourcesForUi,
  listTopics,
  listViewMetaByReviewer,
} from "@/lib/queries";
import type { IngestStatus, SourceKind } from "@/lib/types";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ topicId: string; reviewerId: string }>;
};

export default async function ReviewerPage({ params }: PageProps) {
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

  const [sourceRows, viewMeta, cards, testAttemptStats, topics, topicPacks] =
    await Promise.all([
      listSourcesForUi(reviewerId, userId),
      listViewMetaByReviewer(reviewerId, userId),
      getCardsForReviewer(reviewerId, userId),
      listTestAttemptStats(reviewerId, userId),
      listTopics(userId),
      listReviewersByTopic(topicId, userId),
    ]);
  const dueTodayCount = topicPacks.reduce(
    (sum, pack) => sum + pack.dueTodayCount,
    0,
  );
  const initialSources: SourceListItem[] = sourceRows.map((s) => ({
    id: s.id,
    reviewerId: s.reviewerId,
    filename: s.filename,
    mime: s.mime,
    kind: s.kind as SourceKind,
    blobUrl: s.blobPathname
      ? `/api/reviewers/${reviewerId}/sources/${s.id}`
      : null,
    blobPathname: s.blobPathname,
    ingestStatus: s.ingestStatus as IngestStatus,
    errorMessage: s.errorMessage,
    createdAt: s.createdAt.toISOString(),
  }));

  const initialViews: ViewsPayload = {
    locked_in: null,
    summary: null,
    test_me: null,
    carded: null,
  };

  for (const row of viewMeta) {
    const placeholder = {
      id: row.id,
      reviewerId: row.reviewerId,
      kind: row.kind,
      content: "",
      contentJson: null,
      modelId: row.modelId ?? null,
      generatedAt: row.generatedAt.toISOString(),
      revision: row.revision,
      isEdited: row.isEdited,
      isPinned: row.isPinned,
      updatedAt: row.updatedAt.toISOString(),
    };
    if (row.kind === "locked_in") initialViews.locked_in = placeholder;
    else if (row.kind === "summary") initialViews.summary = placeholder;
    else if (row.kind === "test_me") initialViews.test_me = placeholder;
    else if (row.kind === "carded") initialViews.carded = placeholder;
  }

  return (
    <AppShell
      topics={topics.map((item) => ({
        id: item.id,
        name: item.name,
        sortOrder: item.sortOrder,
        createdAt: item.createdAt.toISOString(),
      }))}
      selectedTopicId={topic.id}
      dueTodayCount={dueTodayCount}
    >
      <ReviewerWorkspace
        userId={userId}
        topicId={topic.id}
        topicName={topic.name}
        reviewerId={reviewer.id}
        reviewerName={reviewer.name}
        initialSources={initialSources}
        initialViews={initialViews}
        lastGeneratedAt={
          reviewer.lastGeneratedAt
            ? reviewer.lastGeneratedAt.toISOString()
            : null
        }
        examDate={reviewer.examDate}
        initialCards={cards.map((card) => ({
          ...card,
          dueAt: card.dueAt.toISOString(),
          lastReviewedAt: card.lastReviewedAt?.toISOString() ?? null,
        }))}
        initialTestAttemptStats={testAttemptStats.map((stats) => ({
          ...stats,
          lastAttemptedAt: stats.lastAttemptedAt?.toISOString() ?? null,
        }))}
      />
    </AppShell>
  );
}
