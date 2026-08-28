/**
 * Vercel Blob helpers for client-direct uploads.
 *
 * Large files (PDF / video / audio) must not pass through the App Router
 * request body — browsers upload bytes straight to Vercel Blob with a
 * short-lived client token from /api/blob/upload.
 *
 * After the upload finishes, the signed-in client POSTs
 * { filename, mime, blob_url, blob_pathname } to
 * /api/reviewers/[id]/sources. That route is the only writer of the
 * `sources` row and the only trigger for ingest.
 *
 * handleUpload's onUploadCompleted is not the persistence path: the Blob
 * service invokes it with no session cookie. Keep it a no-op (no DB writes).
 */

import "server-only";

import { del, put } from "@vercel/blob";
import {
  handleUpload,
  type HandleUploadBody,
} from "@vercel/blob/client";

import type { SourceKind } from "@/lib/types";

/** MIME types accepted for upload and source registration. */
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/tab-separated-values",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/mpeg",
  "video/x-matroska",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
  "audio/x-m4a",
] as const;

export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_MIME_TYPES);

/** 500 MiB — lecture video headroom; Blob still enforces per-token. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const UUID_RE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const USER_REVIEWER_PATH_RE = new RegExp(
  `^users\\/(${UUID_RE})\\/reviewers\\/(${UUID_RE})\\/`,
  "i",
);

export function normalizeMime(mime: string): string {
  return mime.toLowerCase().split(";")[0]?.trim() ?? "";
}

export function isAllowedMime(mime: string): mime is AllowedMime {
  return ALLOWED_MIME_SET.has(normalizeMime(mime));
}

export function kindFromMime(mime: string): SourceKind | null {
  const m = normalizeMime(mime);
  if (!isAllowedMime(m)) return null;
  if (m === "application/pdf") return "pdf";
  if (
    m === "image/jpeg" ||
    m === "image/png" ||
    m === "image/webp" ||
    m === "image/gif"
  ) {
    return "image";
  }
  if (m.startsWith("text/")) return "text";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return null;
}

/** Strip path separators and collapse unsafe characters for blob path segments. */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() || "file";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_");
  const sliced = cleaned.slice(0, 180);
  return sliced.length > 0 ? sliced : "file";
}

/**
 * Namespace: users/<userId>/reviewers/<reviewerId>/<uuid>-<safe-filename>
 * Client should use this (or an equivalent) when calling upload().
 */
export function buildBlobPathname(
  userId: string,
  reviewerId: string,
  filename: string,
): string {
  const id = crypto.randomUUID();
  return `users/${userId}/reviewers/${reviewerId}/${id}-${safeFilename(filename)}`;
}

export function parseUserReviewerFromPathname(
  pathname: string,
): { userId: string; reviewerId: string } | null {
  const match = USER_REVIEWER_PATH_RE.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return { userId: match[1], reviewerId: match[2] };
}

export function assertNamespacedPathname(
  pathname: string,
  opts: {
    userId?: string | null;
    reviewerId?: string | null;
  } = {},
): void {
  const parsed = parseUserReviewerFromPathname(pathname);
  if (!parsed) {
    throw new Error(
      "pathname must be namespaced as users/<userId>/reviewers/<reviewerId>/<uuid>-<filename>",
    );
  }
  if (
    opts.userId &&
    parsed.userId.toLowerCase() !== opts.userId.toLowerCase()
  ) {
    throw new Error("pathname userId does not match session user");
  }
  if (
    opts.reviewerId &&
    parsed.reviewerId.toLowerCase() !== opts.reviewerId.toLowerCase()
  ) {
    throw new Error("pathname reviewerId does not match clientPayload.reviewerId");
  }
}

export type ClientUploadPayload = {
  reviewerId?: string;
  filename?: string;
};

export function parseClientPayload(
  clientPayload: string | null,
): ClientUploadPayload {
  if (!clientPayload) return {};
  try {
    const parsed: unknown = JSON.parse(clientPayload);
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    return {
      reviewerId:
        typeof obj.reviewerId === "string" ? obj.reviewerId : undefined,
      filename: typeof obj.filename === "string" ? obj.filename : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Run the official client-upload handshake (token mint + completed callback).
 * Caller must 401 before this when body.type is blob.generate-client-token
 * and there is no session. onUploadCompleted is intentionally a no-op.
 */
export async function handleClientUpload(args: {
  request: Request;
  body: HandleUploadBody;
  userId: string | null;
}): Promise<
  | { type: "blob.generate-client-token"; clientToken: string }
  | { type: "blob.upload-completed"; response: "ok" }
> {
  return handleUpload({
    request: args.request,
    body: args.body,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      if (!args.userId) {
        throw new Error("Unauthorized");
      }
      const payload = parseClientPayload(clientPayload);
      assertNamespacedPathname(pathname, {
        userId: args.userId,
        reviewerId: payload.reviewerId ?? null,
      });

      return {
        allowedContentTypes: [...ALLOWED_MIME_TYPES],
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        addRandomSuffix: false,
        allowOverwrite: false,
        tokenPayload: clientPayload,
      };
    },
    // No DB writes — client POSTs metadata to /api/reviewers/[id]/sources.
    onUploadCompleted: async () => {},
  });
}

/** Server-side put for tiny text only. Do not use for large PDF/video/audio. */
export async function putTinyTextBlob(
  pathname: string,
  body: string,
  contentType: string = "text/plain",
) {
  return put(pathname, body, {
    access: "public",
    contentType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: false,
  });
}

/** Best-effort blob delete (missing blobs are ignored). */
export async function deleteBlob(urlOrPathname: string): Promise<void> {
  try {
    await del(urlOrPathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch {
    // best effort
  }
}

export type { HandleUploadBody };
