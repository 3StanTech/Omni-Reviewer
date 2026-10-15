"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowClockwise, House } from "@phosphor-icons/react";

import { KirbyCompanion } from "@/components/kirby-companion";
import { Button, buttonVariants } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

/** Error boundary for every page under the root layout; Kirby looks puzzled in Dream Land. */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center px-4 py-16">
      <Panel className="flex w-full max-w-md flex-col items-center gap-4 px-6 py-8 text-center">
        <KirbyCompanion size="md" pose="puzzled" />
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Something went wrong.</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">Your study data is safe. Try again or go back to the desk.</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={() => retry()}>
            <ArrowClockwise weight="bold" aria-hidden />
            Try again
          </Button>
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            <House weight="bold" aria-hidden />
            Back to desk
          </Link>
        </div>
      </Panel>
    </main>
  );
}
