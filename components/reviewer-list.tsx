"use client";

import Link, { useLinkStatus } from "next/link";
import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CaretRight,
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
};

/** Hidden on phones, where the row's right side holds the actions. */
function PackRowChevron() {
  const { pending } = useLinkStatus();
  if (pending) {
    return (
      <>
        <CircleNotch
          className="mt-2 size-4 shrink-0 animate-spin text-muted-foreground max-sm:hidden"
          weight="bold"
          aria-hidden
        />
        <span className="sr-only">Opening</span>
      </>
    );
  }
  return (
    <CaretRight
      className="mt-2 size-4 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100 max-sm:hidden"
      weight="bold"
    />
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

  if (!topicId) {
    return (
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Study packs
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {topicName
              ? `In ${topicName}`
              : "Select a topic to see its packs."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            onClick={() => {
              setError(null);
              setName("");
              setCreateOpen(true);
            }}
          >
            <Plus weight="bold" />
            New pack
          </Button>
        </div>
      </div>

      {reviewers.length === 0 ? (
        <EmptyState
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
        <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-surface/40">
          {reviewers.map((reviewer) => (
            <li key={reviewer.id} className="group flex items-center gap-2 pr-2">
              <Link
                href={`/topics/${topicId}/reviewers/${reviewer.id}`}
                prefetch
                className="flex min-h-14 min-w-0 flex-1 items-start gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
                  <Notebook weight="duotone" className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm font-medium break-words text-foreground">
                    {reviewer.name}
                  </span>
                  <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <GeneratedAtLabel iso={reviewer.lastGeneratedAt} />
                    {reviewer.dueTodayCount > 0 ? (
                      <span>{dueSplitCopy(reviewer.reviewDueCount, reviewer.newTodayCount)}</span>
                    ) : null}
                    {reviewer.examDate ? <span>{reviewer.examDate}</span> : null}
                    <PackMastery mastery={reviewer.mastery} />
                  </span>
                </span>
                <PackRowChevron />
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
    </div>
  );
}
