"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarBlank,
  CircleNotch,
  DotsThreeVertical,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";

import { useLook } from "@/components/look-provider";
import type { TopicListItem } from "@/components/topic-tabs";
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

type TopicNavValue = {
  optimisticId: string | null;
  setOptimisticId: (id: string | null) => void;
};

const TopicNavContext = createContext<TopicNavValue | null>(null);

export function TopicNavProvider({ children }: { children: ReactNode }) {
  const [optimisticId, setOptimisticId] = useState<string | null>(null);
  const value = useMemo(
    () => ({ optimisticId, setOptimisticId }),
    [optimisticId],
  );
  return (
    <TopicNavContext.Provider value={value}>{children}</TopicNavContext.Provider>
  );
}

export function useTopicNav(): TopicNavValue | null {
  return useContext(TopicNavContext);
}

type TopicShelfProps = {
  topics: TopicListItem[];
  selectedId: string | null;
  dueTodayCount: number;
};

export function TopicShelf({
  topics,
  selectedId,
  dueTodayCount,
}: TopicShelfProps) {
  const look = useLook();
  const router = useRouter();
  const topicNav = useTopicNav();
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTopic, setActiveTopic] = useState<TopicListItem | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  if (look !== "remnote") return null;

  function selectTopic(id: string) {
    if (id === selectedId) return;
    topicNav?.setOptimisticId(id);
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
      topicNav?.setOptimisticId(created.id);
      router.push(`/?topic=${created.id}`);
      router.refresh();
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
      router.refresh();
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
      if (next) topicNav?.setOptimisticId(next.id);
      router.push(next ? `/?topic=${next.id}` : "/");
      router.refresh();
    } catch {
      setError("Could not delete topic. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      className="sticky top-0 hidden h-svh w-[228px] shrink-0 flex-col overflow-y-auto border-r border-border bg-chrome md:flex"
      aria-label="Topic shelf"
    >
      <div className="flex flex-col gap-1 p-3">
        <div className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground">
          <CalendarBlank className="size-4 shrink-0" />
          <span>Due today</span>
          <span className="ml-auto tabular-nums text-foreground">
            {dueTodayCount}
          </span>
        </div>

        <div className="mt-3 mb-1 flex items-center justify-between gap-2 px-2.5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Topics
          </p>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="New topic"
            onClick={() => {
              setError(null);
              setName("");
              setCreateOpen(true);
            }}
          >
            <Plus weight="bold" />
          </Button>
        </div>

        {topics.length === 0 ? (
          <p className="px-2.5 text-sm text-muted-foreground">
            No topics yet. Create one to hold your study packs.
          </p>
        ) : (
          <nav aria-label="Topics" className="flex flex-col gap-0.5">
            {topics.map((topic) => {
              const selected = topic.id === selectedId;
              return (
                <div
                  key={topic.id}
                  className={cn(
                    "group flex items-center rounded-lg transition-colors duration-150",
                    selected
                      ? "bg-primary/12 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Link
                    href={`/?topic=${topic.id}`}
                    scroll={false}
                    prefetch
                    aria-current={selected ? "page" : undefined}
                    className="min-h-11 min-w-0 flex-1 truncate rounded-lg px-2.5 py-2 text-sm font-medium text-inherit no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
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
                          size="icon-xs"
                          className={cn(
                            "mr-1 opacity-70 group-hover:opacity-100",
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
          </nav>
        )}
      </div>

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
            <Label htmlFor="shelf-topic-name">Name</Label>
            <Input
              id="shelf-topic-name"
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
              Update the label for this topic.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="shelf-topic-rename">Name</Label>
            <Input
              id="shelf-topic-rename"
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
    </aside>
  );
}
