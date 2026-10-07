import Link from "next/link";
import { BookOpen } from "@phosphor-icons/react/dist/ssr";
import type { ReactNode } from "react";

import { MoodControl } from "@/components/mood-control";
import { SearchPacks } from "@/components/search-packs";
import { SignOutButton } from "@/components/sign-out-button";
import {
  TopicNavProvider,
  TopicShelf,
  TopicShelfToggle,
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
  dueByTopic?: Record<string, number>;
  dueTodayTotal?: number;
  showTopicShelf?: boolean;
  /** The pack page uses the desktop width (90rem) for its document and rail; other pages stay at 64rem. */
  wide?: boolean;
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
  dueByTopic,
  dueTodayTotal = 0,
  showTopicShelf = true,
  wide = false,
}: AppShellProps) {
  return (
    <TopicNavProvider>
      <div className="flex min-h-full flex-1">
        {topics && showTopicShelf ? (
          <div data-focus-hide className="contents">
            <TopicShelf
              topics={topics}
              selectedId={selectedTopicId}
              dueByTopic={dueByTopic}
              dueTodayTotal={dueTodayTotal}
            />
          </div>
        ) : null}
        <div className="flex min-h-full min-w-0 flex-1 flex-col">
          <header data-focus-hide className="sticky top-0 z-40 border-b border-border/70 bg-chrome/90 backdrop-blur-md">
            <div className={cn("mx-auto flex h-14 w-full items-center justify-between gap-3 px-4 sm:px-6", wide ? "max-w-[90rem]" : "max-w-5xl")}>
              <div className="flex min-w-0 items-center gap-3">
                {topics && showTopicShelf ? <TopicShelfToggle /> : null}
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
                <SearchPacks />
                <MoodControl />
                {actions}
                <SignOutButton />
              </div>
            </div>
          </header>

          <main
            className={cn(
              "mx-auto flex w-full flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8",
              wide ? "max-w-[90rem]" : "max-w-5xl",
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
