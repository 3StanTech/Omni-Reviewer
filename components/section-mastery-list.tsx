import { WarningCircle } from "@phosphor-icons/react/dist/ssr";

import { MasteryBar } from "@/components/mastery-bar";
import type { SectionMastery } from "@/lib/mastery";
import type { StudyHeading } from "@/lib/study-outline";
import { WEAK_SECTION_DEFINITION } from "@/lib/today-plan";

// The rail renders this list once per page.
const WEAK_DEFINITION_ID = "rail-weak-section-definition";

/**
 * The Test Me and Carded rail list: Locked In's top two heading levels with a
 * mastery bar each. No links, since those tabs have no Locked In article to jump in.
 */
export function SectionMasteryList({ headings, sections }: { headings: StudyHeading[]; sections: SectionMastery[] | null }) {
  const shown = headings.filter((heading) => heading.level <= 2);
  if (shown.length === 0) return null;
  const byId = new Map((sections ?? []).map((section) => [section.id, section]));
  const anyWeak = shown.some((heading) => byId.get(heading.id)?.weak);
  return (
    <section aria-labelledby="rail-sections-heading" className="space-y-2">
      <h3 id="rail-sections-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Sections
      </h3>
      <ul className="space-y-2 text-sm">
        {shown.map((heading) => {
          const section = byId.get(heading.id);
          const score = section?.score ?? null;
          return (
            <li
              key={heading.id}
              className="flex min-w-0 flex-col gap-0.5"
              style={heading.level > 1 ? { paddingLeft: "0.75rem" } : undefined}
            >
              <span className="flex min-w-0 items-start gap-1.5">
                {section?.weak ? (
                  <WarningCircle
                    weight="fill"
                    role="img"
                    aria-label="Weak section"
                    aria-describedby={WEAK_DEFINITION_ID}
                    className="mt-0.5 size-4 shrink-0 text-warning"
                  >
                    <title>{WEAK_SECTION_DEFINITION}</title>
                  </WarningCircle>
                ) : null}
                <span className="min-w-0 break-words">{heading.text}</span>
              </span>
              {score === null ? (
                <span className="text-xs text-muted-foreground">Not enough answers yet</span>
              ) : (
                <MasteryBar score={score} label />
              )}
            </li>
          );
        })}
      </ul>
      {anyWeak ? (
        <span id={WEAK_DEFINITION_ID} hidden>
          {WEAK_SECTION_DEFINITION}
        </span>
      ) : null}
    </section>
  );
}
