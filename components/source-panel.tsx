"use client";

import { useRef, useState } from "react";
import {
  ArrowClockwise,
  CircleNotch,
  File,
  FilePdf,
  FileText,
  Image as ImageIcon,
  Microphone,
  Trash,
  UploadSimple,
  VideoCamera,
  WarningCircle,
} from "@phosphor-icons/react";

import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  normalizeSource,
  uploadSourceFile,
  type SourceListItem,
} from "@/lib/batch-upload";
import { MAX_PASTE_TEXT_CHARS, MAX_PASTE_TITLE_CHARS } from "@/lib/paste";
import { buildPhotoSetFile, isHeic } from "@/lib/photo-set";
import { unreadableMessage } from "@/lib/use-source-vision";
import type { SourceVision, VisionProgress } from "@/lib/use-source-vision";
import type { IngestStatus, SourceKind } from "@/lib/types";
import { readApiError } from "@/lib/utils";

export type { SourceListItem };

type SourcePanelProps = {
  userId: string;
  reviewerId: string;
  initialSources: SourceListItem[];
  onSourcesChange?: (sources: SourceListItem[]) => void;
  /** When false, hide upload/paste/list. Parent owns the Sources control. */
  expanded?: boolean;
  /**
   * Slide-image reading, hosted by the parent so it keeps running while this
   * panel is hidden or remounted.
   */
  vision?: Pick<SourceVision, "progress" | "register" | "retry">;
};

const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp|gif|heic|heif)$/i;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);

/** Picked photos become one photo-set PDF; everything else uploads as is. */
export function isPhotoFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type) return PHOTO_TYPES.has(type) || isHeic(file);
  return PHOTO_EXTENSIONS.test(file.name);
}

function canRetryStoredFile(source: Pick<SourceListItem, "kind" | "ingestStatus" | "blobPathname">): boolean {
  return source.ingestStatus === "failed"
    && Boolean(source.blobPathname)
    && (source.kind === "pdf"
      || source.kind === "text"
      || source.kind === "document"
      || source.kind === "presentation");
}

/** Ready PDF/PPTX rows known to lack page numbers can be re-read from the stored file. */
export function canRefreshPageNumbers(
  source: Pick<SourceListItem, "kind" | "ingestStatus" | "blobPathname" | "hasPageMarkers">,
): boolean {
  return source.ingestStatus === "ready"
    && Boolean(source.blobPathname)
    && (source.kind === "pdf" || source.kind === "presentation")
    && source.hasPageMarkers === false;
}

function statusLabel(status: IngestStatus): string {
  if (status === "ready") return "Ready";
  if (status === "failed") return "Failed";
  return "Not yet processed";
}

function statusVariant(
  status: IngestStatus,
): "success" | "warning" | "destructive" {
  if (status === "ready") return "success";
  if (status === "failed") return "destructive";
  return "warning";
}

function KindIcon({ kind }: { kind: SourceKind }) {
  const className = "size-4.5";
  switch (kind) {
    case "pdf":
      return <FilePdf className={className} weight="duotone" />;
    case "image":
      return <ImageIcon className={className} weight="duotone" />;
    case "text":
      return <FileText className={className} weight="duotone" />;
    case "document":
    case "presentation":
      return <FileText className={className} weight="duotone" />;
    case "paste":
      return <File className={className} weight="duotone" />;
    case "video":
      return <VideoCamera className={className} weight="duotone" />;
    case "audio":
      return <Microphone className={className} weight="duotone" />;
    default:
      return <File className={className} weight="duotone" />;
  }
}

/** Slide-image reading for one row. A finished read adds nothing unless pages were refused. */
export function VisionStatus({
  progress,
  onRetry,
}: {
  progress: VisionProgress | undefined;
  onRetry: () => void;
}) {
  if (!progress) return null;
  if (progress.state === "reading") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleNotch
          aria-hidden
          className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          weight="bold"
        />
        <span aria-live="polite">
          Reading slide images: {progress.done} of {progress.total}
        </span>
      </p>
    );
  }
  const unreadable = unreadableMessage(progress.unreadable ?? []);
  const note = unreadable ? (
    <p role="status" className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <WarningCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" weight="bold" />
      <span>{unreadable}</span>
    </p>
  ) : null;
  if (progress.state === "done") return note;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p role="status" className="text-xs text-warning">
          {progress.message}
        </p>
        <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
          <ArrowClockwise />
          Try again
        </Button>
      </div>
      {note}
    </>
  );
}

export function SourcePanel({
  userId,
  reviewerId,
  initialSources,
  onSourcesChange,
  expanded = true,
  vision,
}: SourcePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [sources, setSources] = useState(initialSources);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<{ id: string; message: string } | null>(null);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  function commit(next: SourceListItem[]) {
    setSources(next);
    onSourcesChange?.(next);
  }

  /** Upload one file to Blob and register it as a source. */
  async function uploadOne(file: File): Promise<SourceListItem> {
    setProgress(0);
    const source = await uploadSourceFile({
      userId,
      reviewerId,
      file,
      onProgress: setProgress,
    });
    // Reading reuses these bytes instead of downloading the PDF again.
    if (source.kind === "pdf") vision?.register(source.id, file);
    return source;
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setUploading(true);

    const files = Array.from(fileList);
    const photos = files.filter(isPhotoFile);
    const others = files.filter((file) => !isPhotoFile(file));
    const next = [...sources];

    try {
      for (const file of others) {
        next.push(await uploadOne(file));
        commit([...next]);
      }
      if (photos.length > 0) {
        setPreparing({ done: 0, total: photos.length });
        const photoSet = await buildPhotoSetFile(photos, (done, total) => {
          setPreparing({ done, total });
        });
        setPreparing(null);
        next.push(await uploadOne(photoSet));
        commit([...next]);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Upload failed. Check the file type and try again.",
      );
    } finally {
      setUploading(false);
      setProgress(null);
      setPreparing(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function deleteSource(sourceId: string) {
    setDeletingId(sourceId);
    setError(null);
    try {
      const res = await fetch(
        `/api/reviewers/${reviewerId}/sources/${sourceId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      commit(sources.filter((s) => s.id !== sourceId));
    } catch {
      setError("Could not remove source. Try again.");
    } finally {
      setDeletingId(null);
    }
  }

  async function retrySource(sourceId: string) {
    setRetryingId(sourceId);
    setError(null);
    try {
      const res = await fetch(
        `/api/reviewers/${reviewerId}/sources/${sourceId}`,
        { method: "POST" },
      );
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const raw = (await res.json()) as Record<string, unknown>;
      commit(sources.map((source) => (
        source.id === sourceId ? normalizeSource(raw) : source
      )));
    } catch {
      setError("Could not retry source. Try again.");
    } finally {
      setRetryingId(null);
    }
  }

  async function refreshPageNumbers(sourceId: string) {
    setRefreshingId(sourceId);
    setRefreshError(null);
    try {
      const res = await fetch(
        `/api/reviewers/${reviewerId}/sources/${sourceId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "page_markers" }),
        },
      );
      if (!res.ok) {
        setRefreshError({ id: sourceId, message: await readApiError(res) });
        return;
      }
      const raw = (await res.json()) as Record<string, unknown>;
      commit(sources.map((source) => (
        source.id === sourceId ? normalizeSource(raw) : source
      )));
    } catch {
      setRefreshError({ id: sourceId, message: "Could not refresh page numbers. Try again." });
    } finally {
      setRefreshingId(null);
    }
  }

  async function addPaste() {
    if (!pasteText.trim()) return;
    setPasteBusy(true);
    setPasteError(null);
    try {
      const response = await fetch(`/api/reviewers/${reviewerId}/sources/paste`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: pasteTitle.trim() || "Pasted notes",
          text: pasteText,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const raw = (await response.json()) as Record<string, unknown>;
      const next = [...sources, normalizeSource(raw)];
      commit(next);
      setPasteTitle("");
      setPasteText("");
    } catch (caught) {
      setPasteError(
        caught instanceof Error ? caught.message : "Could not add pasted text.",
      );
    } finally {
      setPasteBusy(false);
    }
  }

  return (
    <section
      id="sources-panel"
      className="space-y-3"
      aria-labelledby="sources-heading"
      hidden={!expanded}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="sources-heading"
            className="text-sm font-semibold tracking-tight text-foreground"
          >
            Sources
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            PDFs, slides, documents and photos of slides. Pages that are mostly
            images are read automatically.
          </p>
        </div>
        <div>
          <label
            htmlFor="source-file-upload"
            className="sr-only"
          >
            Upload source files
          </label>
          <input
            ref={inputRef}
            id="source-file-upload"
            name="sourceFiles"
            type="file"
            className="sr-only"
            multiple
            accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.gif,.heic,.heif,image/heic,image/heif,.txt,.md,.csv,.html,.mp4,.webm,.mov,.avi,.mkv,.mp3,.wav,.ogg,.m4a,.aac,.flac,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/*,text/*,video/*,audio/*"
            disabled={uploading}
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <>
                <CircleNotch className="animate-spin" weight="bold" />
                {preparing
                  ? `Preparing ${preparing.total} ${preparing.total === 1 ? "photo" : "photos"}… ${preparing.done} of ${preparing.total}`
                  : progress !== null ? `Uploading ${progress}%` : "Uploading"}
              </>
            ) : (
              <>
                <UploadSimple weight="bold" />
                Upload
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="grid gap-2 rounded-xl border border-border/80 bg-surface/40 p-3 sm:p-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Paste text</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Add notes without uploading a file.
          </p>
        </div>
        <label htmlFor="source-paste-title" className="grid gap-1 text-xs text-muted-foreground">
          Title
          <input
            id="source-paste-title"
            name="pasteTitle"
            value={pasteTitle}
            maxLength={MAX_PASTE_TITLE_CHARS}
            onChange={(event) => setPasteTitle(event.target.value)}
            placeholder="Pasted notes"
            className="min-h-10 rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            disabled={pasteBusy}
          />
        </label>
        <label htmlFor="source-paste-text" className="grid gap-1 text-xs text-muted-foreground">
          Notes
          <textarea
            id="source-paste-text"
            name="pasteText"
            value={pasteText}
            maxLength={MAX_PASTE_TEXT_CHARS}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder="Paste your study material here"
            rows={6}
            className="rounded-lg border border-border/80 bg-background/40 px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            disabled={pasteBusy}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={pasteBusy || !pasteText.trim()} onClick={() => void addPaste()}>
            {pasteBusy ? "Adding" : "Add pasted text"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {pasteText.length.toLocaleString()} / {MAX_PASTE_TEXT_CHARS.toLocaleString()}
          </span>
        </div>
        {pasteError ? <p role="alert" className="text-sm text-destructive">{pasteError}</p> : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {sources.length === 0 ? (
        <EmptyState
          icon={<UploadSimple weight="duotone" className="size-5" />}
          title="No sources yet"
          description="Upload notes, slides, a PDF, or paste text. When at least one source is Ready, you can generate the four study modes."
          action={
            <Button
              type="button"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              <UploadSimple weight="bold" />
              Upload first source
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80 bg-surface/40">
          {sources.map((source) => (
            <li
              key={source.id}
              className="flex items-start gap-3 px-3 py-3 sm:items-center sm:px-4"
            >
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-primary sm:mt-0">
                <KindIcon kind={source.kind} />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {source.filename}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {source.ingestStatus !== "ready" ? (
                    <Badge variant={statusVariant(source.ingestStatus)}>
                      {statusLabel(source.ingestStatus)}
                    </Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground capitalize">
                    {source.kind}
                  </span>
                </div>
                {source.ingestStatus === "failed" && source.errorMessage ? (
                  <p className="text-xs text-destructive">
                    {source.errorMessage}
                  </p>
                ) : null}
                <VisionStatus
                  progress={vision?.progress[source.id]}
                  onRetry={() => vision?.retry(source.id)}
                />
                {refreshError?.id === source.id ? (
                  <p role="alert" className="text-xs text-destructive">
                    {refreshError.message}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canRefreshPageNumbers(source) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    disabled={refreshingId === source.id || deletingId === source.id || uploading}
                    onClick={() => void refreshPageNumbers(source.id)}
                  >
                    {refreshingId === source.id ? (
                      <CircleNotch className="animate-spin" />
                    ) : (
                      <ArrowClockwise />
                    )}
                    {refreshingId === source.id ? "Refreshing" : "Refresh page numbers"}
                  </Button>
                ) : null}
                {canRetryStoredFile(source) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={retryingId === source.id || deletingId === source.id || uploading}
                    onClick={() => void retrySource(source.id)}
                  >
                    {retryingId === source.id ? (
                      <CircleNotch className="animate-spin" />
                    ) : (
                      <ArrowClockwise />
                    )}
                    Retry
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={deletingId === source.id || retryingId === source.id || refreshingId === source.id || uploading}
                  aria-label={`Remove ${source.filename}`}
                  onClick={() => void deleteSource(source.id)}
                >
                  {deletingId === source.id ? (
                    <CircleNotch className="animate-spin" />
                  ) : (
                    <Trash />
                  )}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
