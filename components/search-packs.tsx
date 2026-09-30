"use client";

import { useEffect, useState } from "react";

import { SearchDialog, SearchPacksButton, type SearchResultRow } from "@/components/search-dialog";
import { parseSearchQuery } from "@/lib/search";

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_ERROR = "Search is unavailable right now. Try again.";

/** The header's Search packs button and dialog. Searches run on the server with no model calls. */
export function SearchPacks() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = open ? parseSearchQuery(query) : null;

  useEffect(() => {
    if (!parsed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(parsed)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("search failed");
        const data = (await response.json()) as { results: SearchResultRow[] };
        if (controller.signal.aborted) return;
        setResults(data.results);
      } catch {
        if (controller.signal.aborted) return;
        setResults([]);
        setError(SEARCH_ERROR);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [parsed]);

  return (
    <>
      <SearchPacksButton onClick={() => setOpen(true)} />
      <SearchDialog
        open={open}
        onOpenChange={setOpen}
        query={query}
        onQueryChange={setQuery}
        loading={parsed ? loading : false}
        error={parsed ? error : null}
        results={parsed ? results : []}
      />
    </>
  );
}
