import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { AppShell } from "@/components/app-shell";
import type { ReviewerListItem } from "@/components/reviewer-list";
import { StudyHome } from "@/components/study-home";
import type { TopicListItem } from "@/components/topic-tabs";
import { listActiveUntimedReviewerIds, listReviewersByTopic, listTopics } from "@/lib/queries";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams: Promise<{ topic?: string }>;
};

export default async function HomePage({ searchParams }: HomeProps) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/login");
  }

  const sp = await searchParams;
  const topics = await listTopics(userId);

  const serializedTopics: TopicListItem[] = topics.map((t) => ({
    id: t.id,
    name: t.name,
    sortOrder: t.sortOrder,
    createdAt: t.createdAt.toISOString(),
  }));

  const selectedId =
    (sp.topic && topics.some((t) => t.id === sp.topic) ? sp.topic : null) ??
    topics[0]?.id ??
    null;

  const selectedTopic =
    topics.find((t) => t.id === selectedId) ?? null;

  const [reviewers, activeUntimed] = selectedId
    ? await Promise.all([
      listReviewersByTopic(selectedId, userId),
      listActiveUntimedReviewerIds(userId),
    ])
    : [[], []];
  const activeUntimedIds = new Set(activeUntimed);

  const serializedReviewers: ReviewerListItem[] = reviewers.map((r) => ({
    id: r.id,
    topicId: r.topicId,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
    lastGeneratedAt: r.lastGeneratedAt
      ? r.lastGeneratedAt.toISOString()
      : null,
    examDate: r.examDate,
    dueTodayCount: r.dueTodayCount,
    hasActiveSitting: activeUntimedIds.has(r.id),
  }));

  const dueTodayCount = serializedReviewers.reduce(
    (sum, reviewer) => sum + reviewer.dueTodayCount,
    0,
  );

  return (
    <AppShell
      title="Study desk"
      subtitle="Pick a topic, open a study pack, attach sources, then generate when you are ready."
      topics={serializedTopics}
      selectedTopicId={selectedId}
      dueTodayCount={dueTodayCount}
    >
      <StudyHome
        topics={serializedTopics}
        selectedId={selectedId}
        topicName={selectedTopic?.name ?? null}
        reviewers={serializedReviewers}
      />
    </AppShell>
  );
}
