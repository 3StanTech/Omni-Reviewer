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

/** How long Blob upload progress may stay still before the upload is aborted. */
export const UPLOAD_STALL_MS = 60_000;

export const UPLOAD_STALLED_COPY =
  "Upload stalled. Check your connection and try again.";

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
  // The stall timer covers the Blob `put` only. It restarts only when the
  // upload percentage rises past the highest value seen, so the 0% event each
  // retry reports does not count as progress. When it fires, the upload fails
  // at once and Blob is aborted so it stops at its next attempt.
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectStalled: (error: Error) => void = () => {};
  const stalledPromise = new Promise<never>((_, reject) => {
    rejectStalled = reject;
  });
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      rejectStalled(new Error(UPLOAD_STALLED_COPY));
      controller.abort();
    }, UPLOAD_STALL_MS);
  };
  let highestPercentage = 0;
  // Blob throttles progress with a trailing call that can land after `put`
  // settles; ignore it so it cannot re-arm the timer or move the bar.
  let uploadDone = false;
  let blob: Awaited<ReturnType<typeof put>>;
  try {
    armStallTimer();
    const upload = put(pathname, file, {
      access: "private",
      token: tokenPayload.clientToken,
      contentType: file.type || undefined,
      multipart,
      abortSignal: controller.signal,
      onUploadProgress: ({ percentage }) => {
        if (uploadDone) return;
        if (percentage > highestPercentage) {
          highestPercentage = percentage;
          armStallTimer();
        }
        args.onProgress?.(Math.round(percentage));
      },
    });
    // Whichever promise loses the race must not surface as unhandled.
    upload.catch(() => {});
    stalledPromise.catch(() => {});
    blob = await Promise.race([upload, stalledPromise]);
  } finally {
    uploadDone = true;
    clearTimeout(stallTimer);
  }

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
