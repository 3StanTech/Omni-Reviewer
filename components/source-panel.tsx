"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import {
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
import type { IngestStatus, SourceKind } from "@/lib/types";
import { buildClientBlobPathname, readApiError } from "@/lib/utils";

export type SourceListItem = {
  id: string;
  reviewerId: string;
  filename: string;
  mime: string;
  kind: SourceKind;
  blobUrl: string;
  blobPathname: string;
  ingestStatus: IngestStatus;
  errorMessage: string | null;
  createdAt: string;
};

type SourcePanelProps = {
  userId: string;
  reviewerId: string;
  initialSources: SourceListItem[];
  onSourcesChange?: (sources: SourceListItem[]) => void;
};

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
    blobUrl: String(raw.blobUrl ?? raw.blob_url ?? ""),
    blobPathname: String(raw.blobPathname ?? raw.blob_pathname ?? ""),
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
}: SourcePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [sources, setSources] = useState(initialSources);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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
        const blob = await upload(pathname, file, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          clientPayload: JSON.stringify({
            reviewerId,
            filename: file.name,
          }),
          contentType: file.type || undefined,
          multipart: file.size > 4 * 1024 * 1024,
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

  return (
    <section className="space-y-3" aria-labelledby="sources-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="sources-heading"
            className="text-sm font-semibold tracking-tight text-foreground"
          >
            Sources
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            PDF, image, text, video, or audio. Video and audio stay unprocessed
            in v1.
          </p>
        </div>
        <div>
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.html,.mp4,.webm,.mov,.avi,.mkv,.mp3,.wav,.ogg,.m4a,.aac,.flac,application/pdf,image/*,text/*,video/*,audio/*"
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

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {sources.length === 0 ? (
        <EmptyState
          icon={<UploadSimple weight="duotone" className="size-5" />}
          title="No sources yet"
          description="Upload notes, slides, or a PDF. When at least one source is Ready, you can generate the four study modes."
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
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                disabled={deletingId === source.id || uploading}
                aria-label={`Remove ${source.filename}`}
                onClick={() => void deleteSource(source.id)}
              >
                {deletingId === source.id ? (
                  <CircleNotch className="animate-spin" />
                ) : (
                  <Trash />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
