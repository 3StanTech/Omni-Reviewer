import { EmptyState } from "@/components/empty-state";
import { MarkdownBody } from "@/components/study-markdown";
import { BookOpenText } from "@phosphor-icons/react/dist/ssr";
import { LockedInEditor } from "@/components/locked-in-editor";
import type { LockedInDraftController } from "@/components/locked-in-editor";
import type { MutableRefObject } from "react";
import type { SerializedView, StudyViewSavePatch } from "@/lib/serialize-view";

export { MarkdownBody } from "@/components/study-markdown";

type LockedInViewProps = {
  userId?: string;
  content: string | null;
  view?: SerializedView | null;
  reviewerId?: string;
  onSaved?: (patch: StudyViewSavePatch) => void;
  onDirtyChange?: (dirty: boolean) => void;
  controllerRef?: MutableRefObject<LockedInDraftController | null>;
};

export function LockedInView({
  userId,
  content,
  view,
  reviewerId,
  onSaved,
  onDirtyChange,
  controllerRef,
}: LockedInViewProps) {
  if (!content || !content.trim()) {
    return (
      <EmptyState
        icon={<BookOpenText weight="duotone" className="size-5" />}
        title="Locked In is empty"
        description="Generate the pack to write the full study document from your Ready sources. This mode is the source of truth for the other three."
      />
    );
  }

  if (view && reviewerId && onSaved) {
    return (
      <div>
        <LockedInEditor
          reviewerId={reviewerId}
          userId={userId}
          content={content}
          revision={view.revision}
          isEdited={view.isEdited}
          isPinned={view.isPinned}
          view={view}
          onSaved={onSaved}
          onDirtyChange={onDirtyChange}
          controllerRef={controllerRef}
        />
      </div>
    );
  }

  return (
    <div>
      <article className="reading-surface rounded-xl px-5 py-6 shadow-[0_8px_30px_oklch(0_0_0/20%)] sm:px-8 sm:py-8">
        <MarkdownBody source={content} />
      </article>
    </div>
  );
}
