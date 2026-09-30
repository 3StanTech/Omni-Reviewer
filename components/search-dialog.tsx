"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleNotch, MagnifyingGlass } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type SearchSnippetSegment = { text: string; mark: boolean };

export type SearchResultRow = {
  key: string;
  packName: string;
  kindLabel: string;
  href: string;
  snippet: SearchSnippetSegment[];
};

type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  loading: boolean;
  error: string | null;
  results: SearchResultRow[];
};

const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 200;

/** The header button that opens the dialog. Icon only on narrow screens. */
export function SearchPacksButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" aria-label="Search packs" aria-haspopup="dialog" onClick={onClick}>
      <MagnifyingGlass weight="bold" aria-hidden />
      <span className="hidden sm:inline">Search packs</span>
    </Button>
  );
}

type Group = { packName: string; rows: Array<SearchResultRow & { index: number }> };

/** Group by pack name in first-seen order, numbering rows in display order for the keyboard. */
function groupResults(results: SearchResultRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of results) {
    const group = groups.get(row.packName) ?? { packName: row.packName, rows: [] };
    groups.set(row.packName, group);
    group.rows.push({ ...row, index: 0 });
  }
  let index = 0;
  for (const group of groups.values()) for (const row of group.rows) row.index = index++;
  return [...groups.values()];
}

export function SearchDialog({ open, onOpenChange, query, onQueryChange, loading, error, results }: SearchDialogProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const groups = useMemo(() => groupResults(results), [results]);
  const flat = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const active = flat.length ? Math.min(activeIndex, flat.length - 1) : -1;
  const activeId = active >= 0 ? `${listId}-${active}` : undefined;
  const trimmed = query.trim();
  const searchable = trimmed.length >= MIN_QUERY_CHARS;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  function follow(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || flat.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((active + 1) % flat.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((active - 1 + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      follow(flat[active].href);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={inputRef}
        className="top-[12%] max-h-[calc(100dvh-4rem)] translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-3 p-4 sm:max-w-xl"
      >
        <div className="grid gap-1.5 pr-8">
          <DialogTitle className="sr-only">Search packs</DialogTitle>
          <DialogDescription className="sr-only">
            Search your slides, Locked In notes, summaries and cards across every pack. Use the arrow keys to move and Enter to open.
          </DialogDescription>
          <div className="relative">
            <MagnifyingGlass weight="bold" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              type="search"
              role="combobox"
              aria-label="Search packs"
              aria-expanded={flat.length > 0}
              aria-controls={listId}
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_QUERY_CHARS}
              placeholder="Search slides, notes and cards"
              value={query}
              className="h-11 w-full rounded-lg border border-input bg-surface/50 pr-10 pl-9 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/35 md:text-sm"
              onChange={(event) => {
                setActiveIndex(0);
                onQueryChange(event.target.value);
              }}
              onKeyDown={onInputKeyDown}
            />
            {loading ? (
              <CircleNotch weight="bold" className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
            ) : null}
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto" aria-live="polite">
          {error ? (
            <p role="alert" className="px-1 py-3 text-sm text-destructive">{error}</p>
          ) : !searchable ? (
            <p className="px-1 py-3 text-sm text-muted-foreground">Type at least 2 letters to search every pack.</p>
          ) : loading && flat.length === 0 ? (
            <p role="status" className="px-1 py-3 text-sm text-muted-foreground">Searching</p>
          ) : flat.length === 0 ? (
            <p role="status" className="px-1 py-3 text-sm text-muted-foreground">No results for &ldquo;{trimmed}&rdquo;. Try fewer or different words.</p>
          ) : (
            <div id={listId} role="listbox" aria-label="Search results" className="grid gap-3">
              {groups.map((group) => (
                <div key={group.packName} role="group" aria-label={group.packName}>
                  <p className="px-1 pb-1 text-xs font-semibold text-muted-foreground" aria-hidden>{group.packName}</p>
                  <div className="grid gap-0.5">
                    {group.rows.map((row) => (
                      <Link
                        key={row.key}
                        id={`${listId}-${row.index}`}
                        href={row.href}
                        role="option"
                        aria-selected={row.index === active}
                        tabIndex={-1}
                        className={cn(
                          "grid min-h-11 gap-0.5 rounded-lg px-2.5 py-2 text-sm outline-none hover:bg-muted",
                          row.index === active && "bg-muted ring-1 ring-ring/40",
                        )}
                        onMouseEnter={() => setActiveIndex(row.index)}
                        onClick={(event) => {
                          // Let the browser handle modified clicks (new tab); follow plain clicks ourselves so the dialog closes.
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                          event.preventDefault();
                          follow(row.href);
                        }}
                      >
                        <span className="text-xs font-medium text-primary">{row.kindLabel}</span>
                        <span className="break-words text-foreground/90">
                          {row.snippet.map((segment, position) =>
                            segment.mark ? (
                              <mark key={position} className="rounded-[2px] bg-warning/25 px-0.5 text-foreground">{segment.text}</mark>
                            ) : (
                              <span key={position}>{segment.text}</span>
                            ),
                          )}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
