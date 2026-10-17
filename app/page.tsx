import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { AppShell } from "@/components/app-shell";
import type { ReviewerListItem } from "@/components/reviewer-list";
import { StudyHome } from "@/components/study-home";
import type { TopicListItem } from "@/components/topic-tabs";
import { deskKirbyLook } from "@/lib/desk-kirby";
import { deskSubtitle, parseBirthdayDates } from "@/lib/desk-subtitle";
import { greetingFor } from "@/lib/greeting";
import {
  getFirstRunState,
  getStudyDays,
  getTodayPlan,
  listActiveUntimedReviewerIds,
  listDueByTopic,
  listReviewersByTopic,
  listTopics,
  packMasterySummary,
} from "@/lib/queries";
import { studyWeek } from "@/lib/study-week";

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

  const now = new Date();
  const [reviewers, activeUntimed, today, dueCounts, firstRun, studyDays] = await Promise.all([
    selectedId ? listReviewersByTopic(selectedId, userId) : [],
    selectedId ? listActiveUntimedReviewerIds(userId) : [],
    getTodayPlan(userId),
    listDueByTopic(userId),
    getFirstRunState(userId),
    getStudyDays(userId, now),
  ]);
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
    reviewDueCount: r.reviewDueCount,
    newTodayCount: r.newTodayCount,
    hasActiveSitting: activeUntimedIds.has(r.id),
    mastery: packMasterySummary(today?.mastery.get(r.id)),
  }));

  const bar = today && !today.plan.empty ? today.plan.bar : null;
  const birthday = parseBirthdayDates(process.env.BIRTHDAY_DATES).get(userId) ?? null;
  const subtitle = deskSubtitle({
    now,
    birthday,
    firstRun: firstRun.generatedPacks === 0,
    reviewCards: bar?.reviewCards ?? 0,
    newCards: bar?.newCards ?? 0,
    minutes: bar?.minutes ?? 0,
  });
  const deskKirby = deskKirbyLook({
    now,
    birthday,
    firstRun: firstRun.generatedPacks === 0,
    dueCards: (bar?.reviewCards ?? 0) + (bar?.newCards ?? 0),
  });

  const dueByTopic = Object.fromEntries(dueCounts);
  const dueTodayTotal = [...dueCounts.values()].reduce((sum, count) => sum + count, 0);

  return (
    <AppShell
      title={greetingFor(session?.user?.name, now) ?? "Study desk"}
      subtitle={subtitle}
      deskKirby={deskKirby}
      topics={serializedTopics}
      selectedTopicId={selectedId}
      dueByTopic={dueByTopic}
      dueTodayTotal={dueTodayTotal}
      companion
    >
      <StudyHome
        topics={serializedTopics}
        selectedId={selectedId}
        topicName={selectedTopic?.name ?? null}
        reviewers={serializedReviewers}
        today={today ? { plan: today.plan, packTopicIds: today.packTopicIds } : null}
        firstRun={firstRun.generatedPacks === 0 ? firstRun : null}
        week={studyWeek(studyDays, now)}
        userId={userId}
      />
    </AppShell>
  );
}
