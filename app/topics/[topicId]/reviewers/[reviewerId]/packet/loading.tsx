import { Skeleton } from "@/components/ui/skeleton";

export default function PacketLoading() {
  return (
    <main className="min-h-dvh bg-background px-4 py-6 sm:py-10" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading study packet</span>
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-44" />
        </div>
        <article className="reading-surface space-y-6 rounded-xl px-5 py-6 shadow-[0_8px_30px_oklch(0_0_0/20%)] sm:px-8 sm:py-8">
          <div className="space-y-2 border-b border-border/80 pb-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
        </article>
      </div>
    </main>
  );
}
