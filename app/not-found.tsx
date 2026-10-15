import Link from "next/link";
import { House } from "@phosphor-icons/react/dist/ssr";

import { KirbyCompanion } from "@/components/kirby-companion";
import { buttonVariants } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

export const metadata = { title: "Page not found" };

/** Friendly 404 for unknown URLs and `notFound()`; Kirby looks puzzled in Dream Land. */
export default function NotFound() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center px-4 py-16">
      <Panel className="flex w-full max-w-md flex-col items-center gap-4 px-6 py-8 text-center">
        <KirbyCompanion size="md" pose="puzzled" />
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">This page wandered off.</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">It may have been moved or deleted.</p>
        </div>
        <Link href="/" className={buttonVariants()}>
          <House weight="bold" aria-hidden />
          Back to desk
        </Link>
      </Panel>
    </main>
  );
}
