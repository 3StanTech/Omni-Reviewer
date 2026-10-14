"use client";

import Link, { useLinkStatus } from "next/link";
import { useId, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Cards,
  CircleNotch,
  DotsThreeVertical,
  Exam,
  Notebook,
  PencilSimple,
  Plus,
  Trash,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";

import { EmptyState } from "@/components/empty-state";
import { MasteryBar } from "@/components/mastery-bar";
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
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { formatStamp } from "@/lib/format-generated-at";
import { BATCH_ACCEPT } from "@/lib/generation-queue";
import { useIsClient } from "@/lib/use-is-client";
import { dueSplitCopy, WEAK_SECTION_DEFINITION } from "@/lib/today-plan";
import { readApiError } from "@/lib/utils";

export type ReviewerListItem = {
  id: string;
  topicId: string;
  name: string;
  createdAt: string;
  lastGeneratedAt: string | null;
  examDate: string | null;
  /** Due today: `reviewDueCount + newTodayCount`; shows the Review button. */
  dueTodayCount: number;
  reviewDueCount: number;
  newTodayCount: number;
  hasActiveSitting?: boolean;
  /** Pack mastery, and the weakest section's title when that section is weak. */
  mastery?: { score: number | null; weakTitle: string | null } | null;
};

/** The pack row's mastery bar and weak-section chip; nothing until the pack has a score. */
export function PackMastery({ mastery }: { mastery: ReviewerListItem["mastery"] }) {
  const weakDefinitionId = useId();
  if (!mastery) return null;
  return (
    <>
      {mastery.score !== null ? (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          Mastery
          <MasteryBar score={mastery.score} label />
        </span>
      ) : null}
      {mastery.weakTitle ? (
        <span
          className="flex min-w-0 basis-full items-start gap-1"
          title={WEAK_SECTION_DEFINITION}
          aria-describedby={weakDefinitionId}
        >
          <WarningCircle weight="bold" aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
          <span className="line-clamp-1 min-w-0 break-words">Weak: {mastery.weakTitle}</span>
          <span id={weakDefinitionId} hidden>
            {WEAK_SECTION_DEFINITION}
          </span>
        </span>
      ) : null}
    </>
  );
}

type ReviewerListProps = {
  topicId: string | null;
  topicName: string | null;
  reviewers: ReviewerListItem[];
  /** Make one queued pack per picked file. Absent hides the batch button. */
  onAddFiles?: (files: File[]) => void;
  addingFiles?: boolean;
  /** Topic chips under the panel header (phones, or desktop with the shelf closed). */
  topicChips?: ReactNode;
  /** A topic switch is in flight: the panel keeps its frame and shows skeleton rows. */
  loading?: boolean;
};

function PackRowsSkeleton() {
  return (
    <div className="divide-y divide-divider" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading study packs</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3.5 px-4 py-3.5">
          <Skeleton className="size-9 shrink-0 max-md:hidden" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A spinner while the pack opens; hidden on phones, where the row's right side holds the actions. */
function PackRowPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <>
      <CircleNotch
        className="size-4 shrink-0 self-center animate-spin text-muted-foreground max-sm:hidden"
        weight="bold"
        aria-hidden
      />
      <span className="sr-only">Opening</span>
    </>
  );
}

function GeneratedAtLabel({ iso }: { iso: string | null }) {
  const isClient = useIsClient();
  if (!iso) {
    return <span suppressHydrationWarning>Not generated yet</span>;
  }
  // The server does not know the viewer's zone, so the time appears after mount.
  const stamp = isClient ? formatStamp(iso) : null;
  const text = stamp ? `Generated ${stamp}` : "Generated";
  return <span suppressHydrationWarning>{text}</span>;
}

export function ReviewerList({
  topicId,
  topicName,
  reviewers,
  onAddFiles,
  addingFiles = false,
  topicChips,
  loading = false,
}: ReviewerListProps) {
  const router = useRouter();
  const filesRef = useRef<HTMLInputElement>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [active, setActive] = useState<ReviewerListItem | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) {
    // Same frame as the loaded list below, so the topic chips keep their state.
    return (
      <>
        <Panel aria-label="Study packs" className="overflow-hidden">
          <PanelHeader
            label="Study packs"
            actions={<Skeleton className="h-8 w-36" />}
          />
          {topicChips}
          <PackRowsSkeleton />
        </Panel>
      </>
    );
  }

  if (!topicId) {
    return (
      <div className="space-y-4">
        {topicChips}
        <EmptyState
        icon={<Notebook weight="duotone" className="size-5" />}
        title="Create a topic first"
        description="Topics are the tabs across the top. Start with a course or subject, then add study packs inside it."
        action={
          <p className="text-sm text-muted-foreground">
            Use New topic above to begin.
          </p>
        }
      />
      </div>
    );
  }

  async function createReviewer() {
    if (!topicId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Pack name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reviewers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId, name: trimmed }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const created = (await res.json()) as ReviewerListItem;
      setCreateOpen(false);
      setName("");
      startTransition(() => {
        router.push(`/topics/${topicId}/reviewers/${created.id}`);
        router.refresh();
      });
    } catch {
      setError("Could not create study pack. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function renameReviewer() {
    if (!active) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Pack name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reviewers/${active.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      setRenameOpen(false);
      setActive(null);
      setName("");
      startTransition(() => router.refresh());
    } catch {
      setError("Could not rename study pack. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteReviewer() {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reviewers/${active.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      setDeleteOpen(false);
      setActive(null);
      startTransition(() => router.refresh());
    } catch {
      setError("Could not delete study pack. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <Panel aria-label="Study packs" className="overflow-hidden">
      <PanelHeader
        className="max-md:flex-wrap max-md:*:last:w-full"
        label={
          <>
            Study packs
            <span className="tracking-normal normal-case">
              {" · "}
              {topicName ? `In ${topicName}` : "Select a topic to see its packs."}
            </span>
          </>
        }
        actions={
          <>
            {onAddFiles ? (
              <>
                <input
                  ref={filesRef}
                  type="file"
                  multiple
                  accept={BATCH_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    if (files.length > 0) onAddFiles(files);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="pointer-fine:h-8 pointer-fine:min-h-8 max-md:flex-1"
                  disabled={addingFiles}
                  onClick={() => filesRef.current?.click()}
                >
                  {addingFiles ? (
                    <CircleNotch className="animate-spin" weight="bold" />
                  ) : (
                    <UploadSimple weight="bold" />
                  )}
                  New packs from files
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              className="pointer-fine:h-8 pointer-fine:min-h-8 max-md:flex-1"
              onClick={() => {
                setError(null);
                setName("");
                setCreateOpen(true);
              }}
            >
              <Plus weight="bold" />
              New pack
            </Button>
          </>
        }
      />
      {topicChips}
      {reviewers.length === 0 ? (
        <EmptyState
          className="rounded-none border-0 bg-transparent"
          icon={<Notebook weight="duotone" className="size-5" />}
          title="No study packs yet"
          description="A pack holds the sources you upload and the four study modes you generate from them."
          action={
            <Button
              type="button"
              onClick={() => {
                setError(null);
                setName("");
                setCreateOpen(true);
              }}
            >
              <Plus weight="bold" />
              Create first pack
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-divider">
          {reviewers.map((reviewer) => (
            <li key={reviewer.id} className="group flex items-center gap-1.5 pr-3 max-md:items-start max-md:py-2">
              <Link
                href={`/topics/${topicId}/reviewers/${reviewer.id}`}
                prefetch
                className="flex min-h-14 min-w-0 flex-1 items-center gap-3.5 px-4 py-3.5 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 max-md:py-1.5"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[calc(var(--radius)-3px)] bg-accent text-primary max-md:hidden">
                  <Notebook weight="duotone" className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[0.9375rem] font-semibold break-words text-foreground">
                    {reviewer.name}
                  </span>
                  <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8125rem] text-muted-foreground">
                    <GeneratedAtLabel iso={reviewer.lastGeneratedAt} />
                    {reviewer.dueTodayCount > 0 ? (
                      <span>{dueSplitCopy(reviewer.reviewDueCount, reviewer.newTodayCount)}</span>
                    ) : null}
                    {reviewer.examDate ? <span>{reviewer.examDate}</span> : null}
                    <PackMastery mastery={reviewer.mastery} />
                  </span>
                </span>
                <PackRowPending />
              </Link>
              {reviewer.dueTodayCount > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="max-sm:size-11 max-sm:px-0"
                  nativeButton={false}
                  aria-label={`Review due cards in ${reviewer.name}`}
                  render={<Link href={`/topics/${topicId}/reviewers/${reviewer.id}?mode=carded`} />}
                >
                  <Cards aria-hidden weight="bold" className="sm:hidden" />
                  <span className="max-sm:sr-only">Review</span>
                </Button>
              ) : reviewer.hasActiveSitting ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="max-sm:size-11 max-sm:px-0"
                  nativeButton={false}
                  aria-label={`Resume Test Me in ${reviewer.name}`}
                  render={<Link href={`/topics/${topicId}/reviewers/${reviewer.id}?mode=test_me`} />}
                >
                  <Exam aria-hidden weight="bold" className="sm:hidden" />
                  <span className="max-sm:sr-only">Resume</span>
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="pointer-coarse:size-11"
                      aria-label={`Actions for ${reviewer.name}`}
                    />
                  }
                >
                  <DotsThreeVertical weight="bold" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem
                    onClick={() => {
                      setActive(reviewer);
                      setName(reviewer.name);
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
                      setActive(reviewer);
                      setError(null);
                      setDeleteOpen(true);
                    }}
                  >
                    <Trash />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
    </Panel>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New pack</DialogTitle>
            <DialogDescription>
              Name this study pack. You will upload sources and generate study
              modes inside it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reviewer-name">Pack name</Label>
            <Input
              id="reviewer-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Week 3 lectures"
              disabled={busy}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createReviewer();
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
            <Button
              type="button"
              onClick={() => void createReviewer()}
              disabled={busy}
            >
              {busy ? (
                <>
                  <CircleNotch className="animate-spin" />
                  Creating
                </>
              ) : (
                "Create pack"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename pack</DialogTitle>
            <DialogDescription>
              Update the name of this study pack.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reviewer-rename">Pack name</Label>
            <Input
              id="reviewer-rename"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void renameReviewer();
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
            <Button
              type="button"
              onClick={() => void renameReviewer()}
              disabled={busy}
            >
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
            <DialogTitle>Delete pack</DialogTitle>
            <DialogDescription>
              This removes the study pack, its sources, and all generated study
              modes. This cannot be undone.
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
              onClick={() => void deleteReviewer()}
              disabled={busy}
            >
              {busy ? (
                <>
                  <CircleNotch className="animate-spin" />
                  Deleting
                </>
              ) : (
                "Delete pack"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
