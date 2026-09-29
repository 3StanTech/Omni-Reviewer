"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import {
  ReviewerList,
  type ReviewerListItem,
} from "@/components/reviewer-list";
import { TodayBar } from "@/components/today-bar";
import { TodayModal, type TodayHrefs } from "@/components/today-modal";
import { TopicTabs, type TopicListItem } from "@/components/topic-tabs";
import { useTopicNav } from "@/components/topic-shelf";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { outlineHeadingHref } from "@/lib/study-outline";
import type { TodayPlan } from "@/lib/today-plan";

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
  /** Null while the user has no packs; the Today bar is then hidden. */
  today: StudyHomeToday | null;
};

function ReviewerListSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading study packs</span>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-11 w-36" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border/80">
        <Skeleton className="h-16 w-full rounded-none" />
        <Skeleton className="h-16 w-full rounded-none" />
        <Skeleton className="h-16 w-full rounded-none" />
      </div>
    </div>
  );
}

export function StudyHome({
  topics,
  selectedId,
  topicName,
  reviewers,
  today,
}: StudyHomeProps) {
  const topicNav = useTopicNav();
  const [todayOpen, setTodayOpen] = useState(false);
  const packTopicIds = today?.packTopicIds;
  const hrefs = useMemo(() => todayHrefs(packTopicIds ?? {}), [packTopicIds]);
  const shelfOpen = topicNav?.shelfOpen ?? true;
  const duePack = reviewers.find((reviewer) => reviewer.dueTodayCount > 0) ?? null;
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
    <div className="flex flex-col gap-8">
      {today || (duePack && selectedId) ? (
        <div className="flex flex-col gap-3">
          {today ? (
            <>
              <TodayBar plan={today.plan} onOpen={() => setTodayOpen(true)} />
              <TodayModal
                plan={today.plan}
                open={todayOpen}
                onOpenChange={setTodayOpen}
                hrefs={hrefs}
              />
            </>
          ) : null}
          {duePack && selectedId ? (
            <Button
              nativeButton={false}
              render={
                <Link href={`/topics/${selectedId}/reviewers/${duePack.id}?mode=carded`} />
              }
            >
              Practice due cards
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className={shelfOpen ? "md:hidden" : undefined}>
        <TopicTabs
          topics={topics}
          selectedId={effectiveSelected}
          onOptimisticSelect={setOptimisticId}
        />
      </div>
      {topicPending ? (
        <ReviewerListSkeleton />
      ) : (
        <ReviewerList
          topicId={selectedId}
          topicName={topicName}
          reviewers={reviewers}
        />
      )}
    </div>
  );
}
