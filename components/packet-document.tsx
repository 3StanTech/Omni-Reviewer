"use client";

import { MarkdownBody } from "@/components/study-markdown";
import { stripCitations, UNSOURCED_TOKEN } from "@/lib/citations";
import { isClozeCardFront, renderClozeText } from "@/lib/learning";
import { stripPageMarkers } from "@/lib/source-markers";
import { UNSOURCED_EXPORT_TEXT } from "@/lib/study-export";

export type PacketCard = { id: string; front: string; back: string };

type PacketDocumentProps = {
  packName: string;
  topicName: string;
  generatedOn: string;
  lockedIn: string;
  summary: string;
  cards: PacketCard[];
};

const EMPTY_TEXT = "Not generated yet";

/** Print copy: page markers and citation chips removed, unsourced claims labelled in words. */
function packetMarkdown(markdown: string): string {
  const labelled = stripPageMarkers(markdown)
    .split(UNSOURCED_TOKEN)
    .reduce((out, part, index) => {
      if (index === 0) return part;
      const needsSpace = out.length > 0 && !/\s$/.test(out);
      return `${out}${needsSpace ? " " : ""}${UNSOURCED_EXPORT_TEXT}${part}`;
    }, "");
  return stripCitations(labelled).trim();
}

function EmptySection() {
  return <p className="text-sm text-muted-foreground">{EMPTY_TEXT}</p>;
}

function MarkdownSection({ title, markdown }: { title: string; markdown: string }) {
  const source = packetMarkdown(markdown);
  return (
    <section className="packet-section space-y-4" aria-label={title}>
      <h2 className="font-heading text-2xl font-semibold tracking-tight">{title}</h2>
      {source ? <MarkdownBody source={source} /> : <EmptySection />}
    </section>
  );
}

function CardItem({ card }: { card: PacketCard }) {
  const cloze = isClozeCardFront(card.front);
  const front = packetMarkdown(cloze ? renderClozeText(card.front) : card.front);
  const revealed = cloze ? packetMarkdown(renderClozeText(card.front, true)) : "";
  const back = packetMarkdown(card.back);
  return (
    <li className="packet-card space-y-2 rounded-lg border border-border/80 p-4">
      <MarkdownBody source={front} />
      <div className="space-y-1 border-t border-border/80 pt-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Answer:</p>
        {revealed ? <MarkdownBody source={revealed} /> : null}
        {back ? <MarkdownBody source={back} /> : null}
      </div>
    </li>
  );
}

/** The study packet document that the PDF download renders. */
export function PacketDocument({ packName, topicName, generatedOn, lockedIn, summary, cards }: PacketDocumentProps) {
  return (
    <main className="packet-page min-h-dvh bg-background px-4 py-6 sm:py-10">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <article className="print-document reading-surface space-y-10 rounded-xl px-5 py-6 shadow-[0_8px_30px_oklch(0_0_0/20%)] sm:px-8 sm:py-8">
          <div className="space-y-1 border-b border-border/80 pb-4">
            <p className="text-sm text-muted-foreground">{topicName}</p>
            <h1 className="font-heading text-3xl font-semibold tracking-tight">{packName}</h1>
            <p className="text-sm text-muted-foreground">Study packet generated {generatedOn}</p>
          </div>

          <MarkdownSection title="Locked In" markdown={lockedIn} />
          <MarkdownSection title="Summary" markdown={summary} />

          <section className="packet-section space-y-4" aria-label="Cards">
            <h2 className="font-heading text-2xl font-semibold tracking-tight">Cards</h2>
            {cards.length > 0 ? (
              <ol className="list-decimal space-y-4 pl-6 marker:text-muted-foreground">
                {cards.map((card) => (
                  <CardItem key={card.id} card={card} />
                ))}
              </ol>
            ) : (
              <EmptySection />
            )}
          </section>
        </article>
      </div>
    </main>
  );
}
