import { CheckCircle, Compass } from "@phosphor-icons/react";

import { Panel, PanelHeader } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

export type FirstRunGuideState = {
  topics: number;
  packsWithReadySource: number;
  generatedPacks: number;
};

const STEPS = [
  {
    key: "topic",
    title: "Make a topic",
    hint: "Use New topic in the shelf for a course or subject.",
  },
  {
    key: "pack",
    title: "Add a pack and its handout",
    hint: "Use New pack in your topic, then attach the handout.",
  },
  {
    key: "generate",
    title: "Generate",
    hint: "Open the pack and press Generate.",
  },
] as const;

/** The step a new user is on: 0 topic, 1 pack with a ready source, 2 generate. */
export function firstRunStep(state: FirstRunGuideState): number {
  if (state.topics === 0) return 0;
  if (state.packsWithReadySource === 0) return 1;
  return 2;
}

/** Three-step guide shown on the desk until the first pack is generated. */
export function FirstRunGuide({ state }: { state: FirstRunGuideState }) {
  const current = firstRunStep(state);
  return (
    <Panel className="print-hide" aria-labelledby="first-run-guide-title">
      <PanelHeader
        label={<span id="first-run-guide-title">Get started</span>}
        icon={<Compass weight="bold" aria-hidden className="size-4 shrink-0" />}
        wrapLabel
      />
      <ol className="grid gap-2 p-4 sm:grid-cols-3">
        {STEPS.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li
              key={step.key}
              data-guide-step={step.key}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex min-w-0 gap-3 rounded-lg border px-3 py-2.5",
                active ? "border-primary/40 bg-primary/10" : "border-divider",
              )}
            >
              {done ? (
                <CheckCircle weight="fill" aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums",
                    active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                  )}
                >
                  {index + 1}
                </span>
              )}
              <div className="min-w-0">
                <p className={cn("text-sm font-semibold break-words", done ? "text-muted-foreground" : "text-foreground")}>
                  {step.title}
                  {done ? <span className="sr-only"> (done)</span> : null}
                </p>
                <p className="text-xs break-words text-muted-foreground">{step.hint}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
