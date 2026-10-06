import { put } from "@vercel/blob/client";

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
  /** Whether stored text carries page or slide numbers. null or absent means unknown. */
  hasPageMarkers?: boolean | null;
};

export function normalizeSource(raw: Record<string, unknown>): SourceListItem {
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
    hasPageMarkers:
      typeof raw.hasPageMarkers === "boolean" ? raw.hasPageMarkers : null,
  };
}

/**
 * Upload one file to Blob and register it as a source of the pack. The pack
 * page and the Study desk's batch upload share this sequence: client token
 * (with its attempt token), private `put`, then synchronous ingest.
 */
export async function uploadSourceFile(args: {
  userId: string;
  reviewerId: string;
  file: File;
  onProgress?: (percentage: number) => void;
}): Promise<SourceListItem> {
  const { userId, reviewerId, file } = args;
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
      args.onProgress?.(Math.round(percentage));
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

  return normalizeSource((await res.json()) as Record<string, unknown>);
}
