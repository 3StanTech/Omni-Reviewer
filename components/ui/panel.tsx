import type * as React from "react";

import { cn } from "@/lib/utils";

type PanelProps<T extends React.ElementType = "section"> = {
  as?: T;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ComponentPropsWithoutRef<T>, "as" | "className" | "children">;

function Panel<T extends React.ElementType = "section">({
  as,
  className,
  children,
  ...props
}: PanelProps<T>) {
  const Component: React.ElementType = as ?? "section";
  return (
    <Component
      data-slot="panel"
      className={cn(
        "rounded-[var(--radius)] border border-border bg-card shadow-[var(--panel-shadow)]",
        className,
      )}
      {...props}
    >
      {children}
    </Component>
  );
}

type PanelHeaderProps = {
  label: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  /** Let the label wrap instead of truncating (the Today card never truncates). */
  wrapLabel?: boolean;
  /** Dream Land draws the label as a sticker pill over the panel's top edge (desk panels only). */
  sticker?: boolean;
  className?: string;
};

function PanelHeader({ label, icon, actions, wrapLabel = false, sticker = false, className }: PanelHeaderProps) {
  return (
    <div
      data-slot="panel-header"
      data-sticker={sticker ? "" : undefined}
      className={cn(
        "flex items-center justify-between gap-3 rounded-t-[var(--radius)] border-b border-divider bg-card-head px-4 py-2.5",
        className,
      )}
    >
      <div data-slot="panel-title" className="flex min-w-0 items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {icon}
        <span className={wrapLabel ? undefined : "truncate"}>{label}</span>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export { Panel, PanelHeader };
