import Link from "next/link";
import { BookOpen } from "@phosphor-icons/react/dist/ssr";
import type { ReactNode } from "react";

import { MoodControl } from "@/components/mood-control";
import { SignOutButton } from "@/components/sign-out-button";
import {
  TopicNavProvider,
  TopicShelf,
} from "@/components/topic-shelf";
import type { TopicListItem } from "@/components/topic-tabs";
import { cn } from "@/lib/utils";

type AppShellProps = {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  className?: string;
  topics?: TopicListItem[];
  selectedTopicId?: string | null;
  dueTodayCount?: number;
  showTopicShelf?: boolean;
};

export function AppShell({
  children,
  title,
  subtitle,
  breadcrumb,
  actions,
  className,
  topics,
  selectedTopicId = null,
  dueTodayCount = 0,
  showTopicShelf = true,
}: AppShellProps) {
  return (
    <TopicNavProvider>
      <div className="flex min-h-full flex-1">
        {topics && showTopicShelf ? (
          <TopicShelf
            topics={topics}
            selectedId={selectedTopicId}
            dueTodayCount={dueTodayCount}
          />
        ) : null}
        <div className="flex min-h-full min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 border-b border-border/70 bg-chrome/90 backdrop-blur-md">
            <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <Link
                  href="/"
                  className="flex shrink-0 items-center gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                >
                  <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                    <BookOpen weight="duotone" className="size-4.5" />
                  </span>
                  <span className="text-sm font-semibold tracking-tight">
                    Omni-Reviewer
                  </span>
                </Link>
                {breadcrumb ? (
                  <div className="hidden min-w-0 items-center gap-2 text-sm text-muted-foreground md:flex">
                    <span className="text-border">/</span>
                    {breadcrumb}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <MoodControl />
                {actions}
                <SignOutButton />
              </div>
            </div>
          </header>

          <main
            className={cn(
              "mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8",
              className,
            )}
          >
            {(title || subtitle) && (
              <div className="mb-6 space-y-1">
                {title ? (
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[1.75rem]">
                    {title}
                  </h1>
                ) : null}
                {subtitle ? (
                  <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                    {subtitle}
                  </p>
                ) : null}
              </div>
            )}
            {children}
          </main>
        </div>
      </div>
    </TopicNavProvider>
  );
}
