"use client";

import { Note } from "@phosphor-icons/react/dist/ssr";

import { EmptyState } from "@/components/empty-state";
import { StudyDocument } from "@/components/study-document";
import { MarkdownBody } from "@/components/study-markdown";
import type { LockedInDraftController } from "@/components/locked-in-editor";
import type { MutableRefObject } from "react";
import type { SerializedView, StudyViewSavePatch } from "@/lib/serialize-view";

type SummaryViewProps = {
  userId?: string;
  content: string | null;
  view?: SerializedView | null;
  reviewerId?: string;
  onSaved?: (patch: StudyViewSavePatch) => void;
  onDirtyChange?: (dirty: boolean) => void;
  controllerRef?: MutableRefObject<LockedInDraftController | null>;
};

export function SummaryView({ userId, content, view, reviewerId, onSaved, onDirtyChange, controllerRef }: SummaryViewProps) {
  if (!content || !content.trim()) {
    return (
      <EmptyState
        icon={<Note weight="duotone" className="size-5" />}
        title="Summary is empty"
        description="Generate the pack to write a detailed summary of Locked In for last-minute review."
      />
    );
  }

  if (view && reviewerId && onSaved) {
    return <StudyDocument key={view.id} userId={userId} reviewerId={reviewerId} kind="summary" view={view} onSaved={onSaved} onDirtyChange={onDirtyChange} controllerRef={controllerRef} />;
  }
  return (
    <article className="reading-surface rounded-xl px-5 py-6 shadow-[0_8px_30px_oklch(0_0_0/20%)] sm:px-8 sm:py-8">
      <MarkdownBody source={content} />
    </article>
  );
}
