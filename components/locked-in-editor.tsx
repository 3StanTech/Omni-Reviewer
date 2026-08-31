"use client";

import { useState } from "react";

import { MarkdownBody } from "@/components/study-markdown";
import type { SerializedView } from "@/lib/serialize-view";
import { readApiError } from "@/lib/utils";

type LockedInEditorProps = {
  reviewerId: string;
  content: string;
  revision: number;
  isEdited: boolean;
  isPinned: boolean;
  onSaved: (patch: Partial<SerializedView>) => void;
};

export function LockedInEditor({
  reviewerId,
  content,
  revision,
  isEdited,
  isPinned,
  onSaved,
}: LockedInEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [draftRevision, setDraftRevision] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftIsStale = draftRevision !== revision;
  const visibleDraft = draftIsStale ? content : draft;

  async function save(patch: { content?: string; pinned?: boolean }) {
    if (draftIsStale) {
      setError("This document changed elsewhere. Reload the latest content before saving.");
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/views/locked_in`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision, ...patch }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const data = (await response.json()) as { view: Partial<SerializedView> };
      onSaved(data.view);
      if (patch.content !== undefined) setDraft(patch.content);
      if (typeof data.view.revision === "number") setDraftRevision(data.view.revision);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save Locked In.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          onClick={() => {
            setDraft(content);
            setDraftRevision(revision);
            setEditing((open) => !open);
          }}
          disabled={busy}
        >
          {editing ? "Cancel edit" : "Edit Locked In"}
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          onClick={() => void save({ pinned: !isPinned })}
          disabled={busy}
        >
          {isPinned ? "Unpin" : "Pin content"}
        </button>
        {isEdited || isPinned ? <span className="text-xs text-amber-200">Protected from silent overwrite</span> : null}
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={visibleDraft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-80 w-full rounded-xl border border-border bg-background p-4 font-mono text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            aria-label="Edit Locked In markdown"
          />
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            onClick={() => void save({ content: draft })}
            disabled={busy || !draft.trim()}
          >
            {busy ? "Saving" : "Save edit"}
          </button>
          <p className="text-xs text-muted-foreground">Summary, Test Me, and Carded may be stale after this edit. Redo them when ready.</p>
        </div>
      ) : (
        <article className="reading-surface rounded-xl px-5 py-6 shadow-[0_8px_30px_oklch(0_0_0/20%)] sm:px-8 sm:py-8">
          <MarkdownBody source={content} />
        </article>
      )}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
