"use client";

import { useEffect, useMemo, useState } from "react";

import { FirstCelebration, useFirstCelebration } from "@/components/first-celebration";
import { FirstRunGuide, type FirstRunGuideState } from "@/components/first-run-guide";
import { GenerationQueuePanel } from "@/components/generation-queue-panel";
import { GreenGreens } from "@/components/green-greens";
import { cueKirby } from "@/components/kirby-companion";
import {
  ReviewerList,
  type ReviewerListItem,
} from "@/components/reviewer-list";
import { TodayCard } from "@/components/today-card";
import { TodayModal, type TodayHrefs } from "@/components/today-modal";
import { TopicTabs, type TopicListItem } from "@/components/topic-tabs";
import { useTopicNav } from "@/components/topic-shelf";
import { useTour } from "@/components/tour/tour-provider";
import type { TourFacts } from "@/lib/tour";
import type { StudyWeek } from "@/lib/study-week";
import { outlineHeadingHref } from "@/lib/study-outline";
import type { TodayPlan } from "@/lib/today-plan";
import { useGenerationQueue } from "@/lib/use-generation-queue";

export type StudyHomeToday = {
  plan: TodayPlan;
  /** Topic id per pack id, for pack links. */
  packTopicIds: Record<string, string>;
};

/**
 * Today links into a pack: due cards open Carded, a re-test opens Test Me
 * (where Retry missed lives), a re-read opens Locked In at the section heading.
 */
export function todayHrefs(packTopicIds: Record<string, string>): TodayHrefs {
  const pack = (packId: string) => `/topics/${packTopicIds[packId] ?? ""}/reviewers/${packId}`;
  return {
    review: (packId) => `${pack(packId)}?mode=carded`,
    retest: (packId) => `${pack(packId)}?mode=test_me`,
    reread: (packId, sectionId) => `${pack(packId)}?mode=locked_in${outlineHeadingHref(sectionId)}`,
  };
}

type StudyHomeProps = {
  topics: TopicListItem[];
  selectedId: string | null;
  topicName: string | null;
  reviewers: ReviewerListItem[];
  /** Null while the user has no packs; the Today card is then hidden. */
  today: StudyHomeToday | null;
  /** Session user, for the batch upload's Blob paths. Absent hides the batch button. */
  userId?: string | null;
  /** First-run counts while no pack is generated yet; null hides the guide. */
  firstRun?: FirstRunGuideState | null;
  /** The Manila study week for the Today card's row. */
  week?: StudyWeek;
  /** Desk counts for Kirby's tour, passed on every visit. */
  tourFacts?: Pick<TourFacts, "topics" | "packs" | "generatedPacks" | "latestGeneratedPackHref">;
};

export function StudyHome({
  topics,
  selectedId,
  topicName,
  reviewers,
  today,
  userId = null,
  firstRun = null,
  week,
  tourFacts,
}: StudyHomeProps) {
  const topicNav = useTopicNav();
  const tour = useTour();
  const tourReport = tour?.report;
  const deskTopics = tourFacts?.topics;
  const deskPacks = tourFacts?.packs;
  const deskGenerated = tourFacts?.generatedPacks;
  const deskLatestHref = tourFacts?.latestGeneratedPackHref ?? null;
  useEffect(() => {
    if (!tourReport || deskTopics === undefined || deskPacks === undefined || deskGenerated === undefined) return;
    tourReport({
      page: "desk",
      topics: deskTopics,
      packs: deskPacks,
      generatedPacks: deskGenerated,
      latestGeneratedPackHref: deskLatestHref,
      pack: null,
    });
  }, [tourReport, deskTopics, deskPacks, deskGenerated, deskLatestHref]);
  useEffect(() => {
    if (!tourReport) return;
    return () => tourReport({ page: "other", pack: null });
  }, [tourReport]);
  const queue = useGenerationQueue({ userId });
  const firstPack = useFirstCelebration("pack", queue.packsReady > 0);
  const [todayOpen, setTodayOpen] = useState(false);
  const packTopicIds = today?.packTopicIds;
  const hrefs = useMemo(() => todayHrefs(packTopicIds ?? {}), [packTopicIds]);
  const shelfOpen = topicNav?.shelfOpen ?? false;
  const [localOptimisticId, setLocalOptimisticId] = useState<string | null>(
    null,
  );
  const optimisticId = topicNav?.optimisticId ?? localOptimisticId;
  const setOptimisticId = topicNav?.setOptimisticId ?? setLocalOptimisticId;

  useEffect(() => {
    if (optimisticId !== null && optimisticId === selectedId) {
      setOptimisticId(null);
    }
  }, [optimisticId, selectedId, setOptimisticId]);

  const topicPending =
    optimisticId !== null && optimisticId !== selectedId;
  const effectiveSelected = topicPending ? optimisticId : selectedId;

  return (
    <div className="flex flex-1 flex-col gap-5">
      {firstRun && !tour?.running ? <FirstRunGuide state={firstRun} /> : null}
      {firstPack.show ? (
        <FirstCelebration kind="pack" onDone={firstPack.dismiss} onShow={() => cueKirby("desk", "dance")} />
      ) : null}
      {today ? (
        <>
          <TodayCard plan={today.plan} hrefs={hrefs} onOpenPlan={() => setTodayOpen(true)} week={week} />
          <TodayModal
            plan={today.plan}
            open={todayOpen}
            onOpenChange={setTodayOpen}
            hrefs={hrefs}
          />
        </>
      ) : null}
      <GenerationQueuePanel
        rows={queue.rows}
        status={queue.status}
        remove={queue.remove}
        dismissUpload={queue.dismissUpload}
        retry={queue.retry}
        checkAgain={queue.checkAgain}
      />
      <ReviewerList
        topicId={selectedId}
        topicName={topicName}
        reviewers={reviewers}
        loading={topicPending}
        topicChips={
          <div className={shelfOpen ? "md:hidden" : undefined}>
            <TopicTabs
              topics={topics}
              selectedId={effectiveSelected}
              onOptimisticSelect={setOptimisticId}
            />
          </div>
        }
        onAddFiles={userId && selectedId
          ? (files) => void queue.enqueueFiles(files, selectedId)
          : undefined}
        addingFiles={queue.status.uploading}
      />
      <GreenGreens />
    </div>
  );
}
