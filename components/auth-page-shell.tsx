import type { ReactNode } from "react";
import { BookOpen } from "@phosphor-icons/react/dist/ssr";

export function AuthPageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/15 text-primary shadow-[0_0_40px_oklch(0.78_0.12_75/20%)]">
            <BookOpen weight="duotone" className="size-6" />
          </span>
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {subtitle}
            </p>
          </div>
        </div>
        <div className="rounded-2xl border border-border/80 bg-surface/50 p-5 shadow-[0_12px_40px_oklch(0_0_0/25%)] sm:p-6">
          {children}
        </div>
      </div>
    </main>
  );
}
