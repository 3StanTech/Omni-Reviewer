"use client";

import { useRef, useState } from "react";
import { put } from "@vercel/blob/client";
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
} from "@phosphor-icons/react";

import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MAX_PASTE_TEXT_CHARS, MAX_PASTE_TITLE_CHARS } from "@/lib/paste";
import type { IngestStatus, SourceKind } from "@/lib/types";
import { buildClientBlobPathname, readApiError } from "@/lib/utils";

export type SourceListItem = {
  id: string;
  reviewerId: string;
  filename: string;
  mime: string;
  kind: SourceKind;
  blobUrl: string | null;
  blobPathname: string | null;
  ingestStatus: IngestStatus;
  errorMessage: string | null;
  createdAt: string;
};

type SourcePanelProps = {
  userId: string;
  reviewerId: string;
  initialSources: SourceListItem[];
  onSourcesChange?: (sources: SourceListItem[]) => void;
  /** When false, hide upload/paste/list. Parent owns the Sources control. */
  expanded?: boolean;
};

function canRetryStoredFile(source: Pick<SourceListItem, "kind" | "ingestStatus" | "blobPathname">): boolean {
  return source.ingestStatus === "failed"
    && Boolean(source.blobPathname)
    && (source.kind === "pdf"
      || source.kind === "text"
      || source.kind === "document"
      || source.kind === "presentation");
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

function normalizeSource(raw: Record<string, unknown>): SourceListItem {
  return {
    id: String(raw.id),
    reviewerId: String(raw.reviewerId),
    filename: String(raw.filename),
    mime: String(raw.mime),
    kind: raw.kind as SourceKind,
    blobUrl:
      typeof (raw.blobUrl ?? raw.blob_url) === "string"
        ? String(raw.blobUrl ?? raw.blob_url)
        : null,
    blobPathname:
      typeof (raw.blobPathname ?? raw.blob_pathname) === "string"
        ? String(raw.blobPathname ?? raw.blob_pathname)
        : null,
    ingestStatus: (raw.ingestStatus ?? raw.ingest_status) as IngestStatus,
    errorMessage:
      (raw.errorMessage as string | null | undefined) ??
      (raw.error_message as string | null | undefined) ??
      null,
    createdAt: String(raw.createdAt),
  };
}

export function SourcePanel({
  userId,
  reviewerId,
  initialSources,
  onSourcesChange,
  expanded = true,
}: SourcePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [sources, setSources] = useState(initialSources);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  function commit(next: SourceListItem[]) {
    setSources(next);
    onSourcesChange?.(next);
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setUploading(true);

    const files = Array.from(fileList);
    const next = [...sources];

    try {
      for (const file of files) {
        setProgress(0);
        const pathname = buildClientBlobPathname(userId, reviewerId, file.name);
        const multipart = file.size > 4 * 1024 * 1024;
        const tokenResponse = await fetch("/api/blob/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "blob.generate-client-token",
            payload: {
              pathname,
              multipart,
              clientPayload: JSON.stringify({
                reviewerId,
                filename: file.name,
              }),
            },
          }),
        });
        if (!tokenResponse.ok) throw new Error(await readApiError(tokenResponse));
        const tokenPayload = (await tokenResponse.json()) as {
          clientToken?: unknown;
          attemptToken?: unknown;
        };
        if (
          typeof tokenPayload.clientToken !== "string" ||
          typeof tokenPayload.attemptToken !== "string"
        ) {
          throw new Error("Upload token response was invalid. Try again.");
        }
        // The server mints the opaque attempt identity together with the Blob
        // client token. Keep it only for this registration request.
        const attemptToken = tokenPayload.attemptToken;
        const blob = await put(pathname, file, {
          access: "private",
          token: tokenPayload.clientToken,
          contentType: file.type || undefined,
          multipart,
          onUploadProgress: ({ percentage }) => {
            setProgress(Math.round(percentage));
          },
        });

        const res = await fetch(`/api/reviewers/${reviewerId}/sources`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            mime: file.type || "application/octet-stream",
            blob_url: blob.url,
            blob_pathname: blob.pathname,
            attempt_token: attemptToken,
          }),
        });

        if (!res.ok) {
          throw new Error(await readApiError(res));
        }

        const raw = (await res.json()) as Record<string, unknown>;
        next.push(normalizeSource(raw));
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
            PDF, DOCX, PPTX, image, text, or pasted notes. Video and audio stay
            unprocessed in v1.
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
            accept=".pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.html,.mp4,.webm,.mov,.avi,.mkv,.mp3,.wav,.ogg,.m4a,.aac,.flac,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/*,text/*,video/*,audio/*"
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
                {progress !== null ? `Uploading ${progress}%` : "Uploading"}
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
              </div>
              <div className="flex shrink-0 items-center gap-1">
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
                  disabled={deletingId === source.id || retryingId === source.id || uploading}
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
