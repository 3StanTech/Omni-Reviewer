"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowCounterClockwise,
  CalendarCheck,
  CircleNotch,
  DotsThreeVertical,
  GearSix,
  PencilSimple,
  Plus,
  SidebarSimple,
  SignOut,
  Trash,
} from "@phosphor-icons/react";
import { readLocalStorage, writeLocalStorage } from "@/lib/safe-storage";
import { useIsClient } from "@/lib/use-is-client";

import type { TopicListItem } from "@/components/topic-tabs";
import { useTour } from "@/components/tour/tour-provider";
import { TourShelfBridge } from "@/components/tour/tour-shelf-bridge";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
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

export const TOPIC_SHELF_ID = "topic-shelf";
export const TOPIC_SHELF_STORAGE_KEY = "omni-topic-shelf-v2";

type TopicNavValue = {
  optimisticId: string | null;
  setOptimisticId: (id: string | null) => void;
  shelfOpen: boolean;
  setShelfOpen: (open: boolean) => void;
};

const TopicNavContext = createContext<TopicNavValue | null>(null);
const TOPIC_SHELF_TOGGLE_ID = "topic-shelf-toggle";
const shelfListeners = new Set<() => void>();
// Below 768px the shelf is a drawer that starts closed on every load; the
// stored preference belongs to the desktop shelf only, which also starts
// closed until it is opened once.
let drawerOpen = false;

/** The shelf total sums both kinds of due card. */
const DUE_TODAY_DESCRIPTION = "Cards to review plus new cards for today";
// The shelf renders once per page.
const DUE_TODAY_DESCRIPTION_ID = "topic-shelf-due-today-description";

function isDesktopShelf(): boolean {
  return window.matchMedia("(min-width: 768px)").matches;
}

function readShelfOpen(): boolean {
  if (!isDesktopShelf()) return drawerOpen;
  return readLocalStorage(TOPIC_SHELF_STORAGE_KEY) === "open";
}

function subscribeShelf(listener: () => void) {
  shelfListeners.add(listener);
  return () => shelfListeners.delete(listener);
}

function emitShelf() {
  for (const listener of shelfListeners) listener();
}

function focusShelfToggle() {
  document.getElementById(TOPIC_SHELF_TOGGLE_ID)?.focus();
}

export function TopicNavProvider({ children }: { children: ReactNode }) {
  const [optimisticId, setOptimisticId] = useState<string | null>(null);
  const shelfOpen = useSyncExternalStore(
    subscribeShelf,
    readShelfOpen,
    () => false,
  );
  const setShelfOpen = useCallback((open: boolean) => {
    if (isDesktopShelf()) {
      writeLocalStorage(TOPIC_SHELF_STORAGE_KEY, open ? "open" : "closed");
    } else {
      drawerOpen = open;
    }
    emitShelf();
  }, []);

  const value = useMemo(
    () => ({ optimisticId, setOptimisticId, shelfOpen, setShelfOpen }),
    [optimisticId, shelfOpen, setShelfOpen],
  );
  return (
    <TopicNavContext.Provider value={value}>{children}</TopicNavContext.Provider>
  );
}

export function TopicShelfToggle() {
  const topicNav = useTopicNav();
  if (!topicNav) return null;
  return (
    <>
    <TourShelfBridge shelfOpen={topicNav.shelfOpen} setShelfOpen={topicNav.setShelfOpen} />
    <Button
      id={TOPIC_SHELF_TOGGLE_ID}
      data-tour-target="shelf-toggle"
      type="button"
      variant="ghost"
      size="icon-lg"
      className="min-h-11 min-w-11"
      aria-label="Topics"
      aria-expanded={topicNav.shelfOpen}
      aria-controls={TOPIC_SHELF_ID}
      onClick={() => topicNav.setShelfOpen(!topicNav.shelfOpen)}
    >
      <SidebarSimple weight="bold" />
    </Button>
    </>
  );
}

export function useTopicNav(): TopicNavValue | null {
  return useContext(TopicNavContext);
}

type TopicShelfProps = {
  topics: TopicListItem[];
  selectedId: string | null;
  dueByTopic?: Record<string, number>;
  dueTodayTotal: number;
  /** Server action from `lib/sign-out-action.ts`, passed in by the server shell. */
  signOutAction: () => Promise<void>;
};

export function TopicShelf({
  topics,
  selectedId,
  dueByTopic,
  dueTodayTotal,
  signOutAction,
}: TopicShelfProps) {
  const router = useRouter();
  const topicNav = useTopicNav();
  // The server snapshot reads the shelf as closed; once it opens on the client
  // the phone drawer and its backdrop still wait for hydration.
  const isClient = useIsClient();
  const shelfOpen = topicNav?.shelfOpen ?? false;
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTopic, setActiveTopic] = useState<TopicListItem | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The topic just made: the tour keeps step 1b until the desk lists it.
  const [createdTopicId, setCreatedTopicId] = useState<string | null>(null);
  const tour = useTour();
  const tourReport = tour?.report;
  const tourRunning = tour?.running ?? false;

  useEffect(() => {
    tourReport?.({ shelfOpen });
  }, [tourReport, shelfOpen]);

  const topicDialogShown =
    createOpen || (createdTopicId !== null && !topics.some((topic) => topic.id === createdTopicId));
  useEffect(() => {
    if (!tourReport || !topicDialogShown) return;
    tourReport({ dialog: "topic" });
    return () => tourReport({ dialog: null });
  }, [tourReport, topicDialogShown]);

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
      setCreatedTopicId(created.id);
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

  useEffect(() => {
    if (!shelfOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (isDesktopShelf()) return;
      topicNav?.setShelfOpen(false);
      focusShelfToggle();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shelfOpen, topicNav]);

  if (!shelfOpen) return null;

  return (
    <>
    {isClient ? (
    <button
      type="button"
      data-shelf-backdrop
      className="fixed inset-0 z-40 bg-black/40 md:hidden"
      aria-label="Close topics"
      onClick={() => {
        topicNav?.setShelfOpen(false);
        focusShelfToggle();
      }}
    />
    ) : null}
    <aside
      id={TOPIC_SHELF_ID}
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-svh w-[min(228px,86vw)] shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar md:sticky md:z-auto md:w-[228px]",
        !isClient && "max-md:hidden",
      )}
      aria-label="Topic shelf"
    >
      <div className="flex flex-col gap-3 p-3">
        <Panel
          as="div"
          className="flex items-center gap-2 px-3 py-2.5 text-sm"
          title={DUE_TODAY_DESCRIPTION}
        >
          <CalendarCheck className="size-4 shrink-0 text-muted-foreground" />
          <span>Due today</span>
          <span className="ml-auto font-semibold tabular-nums text-foreground" aria-describedby={DUE_TODAY_DESCRIPTION_ID}>
            {dueTodayTotal}
          </span>
          <span id={DUE_TODAY_DESCRIPTION_ID} hidden>
            {DUE_TODAY_DESCRIPTION}
          </span>
        </Panel>

        <Panel as="div" className="overflow-hidden" data-tour-target="topics">
          <PanelHeader
            className="py-1.5 pr-2"
            label="Topics"
            actions={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="pointer-coarse:size-11"
                aria-label="New topic"
                data-tour-target="new-topic"
                onClick={() => {
                  setError(null);
                  setName("");
                  setCreateOpen(true);
                }}
              >
                <Plus weight="bold" />
              </Button>
            }
          />

          {topics.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              No topics yet. Create one to hold your study packs.
            </p>
          ) : (
            <nav aria-label="Topics" className="flex flex-col divide-y divide-divider p-1">
              {topics.map((topic) => {
                const selected = topic.id === selectedId;
                const due = dueByTopic?.[topic.id] ?? 0;
                return (
                  <div
                    key={topic.id}
                    className={cn(
                      "group flex items-start rounded-[calc(var(--radius)-4px)] transition-colors duration-150",
                      selected
                        ? "bg-accent font-semibold text-foreground"
                        : "text-foreground hover:bg-muted",
                    )}
                  >
                    <Link
                      href={`/?topic=${topic.id}`}
                      scroll={false}
                      prefetch
                      aria-current={selected ? "page" : undefined}
                      className="min-h-10 min-w-0 flex-1 rounded-[calc(var(--radius)-4px)] px-2 py-2 text-sm break-words text-inherit no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/40 pointer-coarse:min-h-11"
                      onClick={() => selectTopic(topic.id)}
                    >
                      {topic.name}
                    </Link>
                    {due > 0 ? (
                      <span
                        className="mt-2.5 ml-auto rounded-full bg-muted px-1.5 py-px text-xs font-normal tabular-nums text-foreground"
                        aria-label={`${due} due today`}
                      >
                        {due}
                      </span>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className={cn(
                              "mx-0.5 mt-1.5 opacity-70 group-hover:opacity-100 pointer-coarse:mt-0 pointer-coarse:size-11",
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
        </Panel>
      </div>

      <ShelfSettings signOutAction={signOutAction} />

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        // During the tour, Skip tour beside the dialog stays clickable and an outside press never closes it.
        modal={tourRunning ? "trap-focus" : undefined}
        disablePointerDismissal={tourRunning}
      >
        <DialogContent data-tour-target="topic-dialog">
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
    </>
  );
}

function ShelfSettings({
  signOutAction,
}: {
  signOutAction: () => Promise<void>;
}) {
  const tour = useTour();
  const [signingOut, startSignOut] = useTransition();
  return (
    <div className="mt-auto border-t border-border p-3">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground pointer-coarse:min-h-11"
            />
          }
        >
          <GearSix weight="bold" />
          Settings
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-52">
          {tour?.replayAvailable ? (
            <DropdownMenuItem
              className="items-start pointer-coarse:min-h-11"
              onClick={() => tour.startReplay()}
            >
              <ArrowCounterClockwise className="mt-0.5" />
              <span className="flex flex-col">
                <span>Replay Kirby&apos;s tour</span>
                <span className="text-xs text-muted-foreground">
                  Kirby shows you around again.
                </span>
              </span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="pointer-coarse:min-h-11"
            disabled={signingOut}
            onClick={() => startSignOut(() => signOutAction())}
          >
            {signingOut ? <CircleNotch className="animate-spin" /> : <SignOut />}
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
