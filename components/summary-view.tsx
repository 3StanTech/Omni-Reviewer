import { Note } from "@phosphor-icons/react/dist/ssr";

import { EmptyState } from "@/components/empty-state";
import { InkLegend, MarkdownBody } from "@/components/study-markdown";

type SummaryViewProps = {
  content: string | null;
};

export function SummaryView({ content }: SummaryViewProps) {
  if (!content || !content.trim()) {
    return (
      <EmptyState
        icon={<Note weight="duotone" className="size-5" />}
        title="Summary is empty"
        description="Generate the pack to write a detailed summary of Locked In for last-minute review."
      />
    );
  }

  return (
    <div>
      <article className="reading-surface rounded-xl px-5 py-6 shadow-[0_8px_30px_oklch(0_0_0/20%)] sm:px-8 sm:py-8">
        <MarkdownBody source={content} />
      </article>
      <InkLegend />
    </div>
  );
}
