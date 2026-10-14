import { AppShell } from "@/components/app-shell";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";

// Mirrors the desk: the Today panel, then the Study packs panel with its topic chips and pack rows.
export default function HomeLoading() {
  return (
    <AppShell
      title="Study desk"
      subtitle="Pick a topic, open a study pack, attach sources, then generate when you are ready."
    >
      <div className="flex flex-col gap-5" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading study desk</span>
        <Panel aria-hidden>
          <PanelHeader label="Today" />
          <div className="flex flex-wrap items-center gap-4 p-4">
            <div className="flex gap-6">
              <Skeleton className="h-11 w-16" />
              <Skeleton className="h-11 w-16" />
              <Skeleton className="h-11 w-16" />
            </div>
            <div className="flex gap-1.5 md:ml-auto max-md:w-full">
              <Skeleton className="h-11 w-32" />
              <Skeleton className="h-11 w-32" />
            </div>
          </div>
        </Panel>
        <Panel aria-hidden className="overflow-hidden">
          <PanelHeader label="Study packs" actions={<Skeleton className="h-9 w-28" />} />
          <div className="flex gap-1.5 p-2">
            <Skeleton className="h-10 w-28 rounded-full" />
            <Skeleton className="h-10 w-36 rounded-full" />
            <Skeleton className="h-10 w-24 rounded-full" />
          </div>
          <div className="divide-y divide-divider border-t border-divider">
            <Skeleton className="h-16 w-full rounded-none" />
            <Skeleton className="h-16 w-full rounded-none" />
            <Skeleton className="h-16 w-full rounded-none" />
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
