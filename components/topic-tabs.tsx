"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CircleNotch,
  DotsThreeVertical,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, readApiError } from "@/lib/utils";

export type TopicListItem = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
};

type TopicTabsProps = {
  topics: TopicListItem[];
  selectedId: string | null;
  onOptimisticSelect?: (id: string) => void;
};

export function TopicTabs({
  topics,
  selectedId,
  onOptimisticSelect,
}: TopicTabsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTopic, setActiveTopic] = useState<TopicListItem | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  function selectTopic(id: string) {
    if (id === selectedId) return;
    onOptimisticSelect?.(id);
  }

  async function createTopic() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Topic name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const created = (await res.json()) as TopicListItem;
      setCreateOpen(false);
      setName("");
      startTransition(() => {
        router.push(`/?topic=${created.id}`);
        router.refresh();
      });
    } catch {
      setError("Could not create topic. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function renameTopic() {
    if (!activeTopic) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Topic name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/topics/${activeTopic.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      setRenameOpen(false);
      setActiveTopic(null);
      setName("");
      startTransition(() => router.refresh());
    } catch {
      setError("Could not rename topic. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteTopic() {
    if (!activeTopic) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/topics/${activeTopic.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const next = topics.find((t) => t.id !== activeTopic.id);
      setDeleteOpen(false);
      setActiveTopic(null);
      startTransition(() => {
        router.push(next ? `/?topic=${next.id}` : "/");
        router.refresh();
      });
    } catch {
      setError("Could not delete topic. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Topics
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setError(null);
            setName("");
            setCreateOpen(true);
          }}
        >
          <Plus weight="bold" />
          New topic
        </Button>
      </div>

      {topics.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No topics yet. Create one to hold your study packs.
        </p>
      ) : (
        <div
          role="tablist"
          aria-label="Topics"
          className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
        >
          {topics.map((topic) => {
            const selected = topic.id === selectedId;
            return (
              <div
                key={topic.id}
                className={cn(
                  "group flex shrink-0 items-center rounded-xl border transition-colors",
                  selected
                    ? "border-primary/40 bg-primary/12 text-foreground"
                    : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Link
                  href={`/?topic=${topic.id}`}
                  scroll={false}
                  prefetch
                  role="tab"
                  aria-selected={selected}
                  className="min-h-11 rounded-xl px-3.5 py-2 text-sm font-medium text-inherit no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                  onClick={() => selectTopic(topic.id)}
                >
                  {topic.name}
                </Link>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={cn(
                          "mr-1 size-8 opacity-70 group-hover:opacity-100 pointer-coarse:size-11",
                          selected && "opacity-100",
                        )}
                        aria-label={`Topic actions for ${topic.name}`}
                      />
                    }
                  >
                    <DotsThreeVertical weight="bold" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40">
                    <DropdownMenuItem
                      onClick={() => {
                        setActiveTopic(topic);
                        setName(topic.name);
                        setError(null);
                        setRenameOpen(true);
                      }}
                    >
                      <PencilSimple />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => {
                        setActiveTopic(topic);
                        setError(null);
                        setDeleteOpen(true);
                      }}
                    >
                      <Trash />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
          {pending ? (
            <span className="flex items-center px-2 text-muted-foreground">
              <CircleNotch className="size-4 animate-spin" />
              <span className="sr-only">Loading topic</span>
            </span>
          ) : null}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New topic</DialogTitle>
            <DialogDescription>
              Topics group study packs. Name the subject or course you are
              reviewing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="topic-name">Name</Label>
            <Input
              id="topic-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Organic chemistry"
              disabled={busy}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createTopic();
                }
              }}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void createTopic()} disabled={busy}>
              {busy ? (
                <>
                  <CircleNotch className="animate-spin" />
                  Creating
                </>
              ) : (
                "Create topic"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename topic</DialogTitle>
            <DialogDescription>
              Update the label for this topic tab.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="topic-rename">Name</Label>
            <Input
              id="topic-rename"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void renameTopic();
                }
              }}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRenameOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void renameTopic()} disabled={busy}>
              {busy ? (
                <>
                  <CircleNotch className="animate-spin" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete topic</DialogTitle>
            <DialogDescription>
              This removes the topic and every study pack inside it. This cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void deleteTopic()}
              disabled={busy}
            >
              {busy ? (
                <>
                  <CircleNotch className="animate-spin" />
                  Deleting
                </>
              ) : (
                "Delete topic"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
