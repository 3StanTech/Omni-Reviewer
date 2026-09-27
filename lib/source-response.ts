import { publicSourceErrorMessage } from "@/lib/public-errors";
import { hasPageMarkers } from "@/lib/source-markers";

export function serializeSource(row: {
  id: string;
  reviewerId: string;
  filename: string;
  mime: string;
  kind: string;
  blobUrl: string | null;
  blobPathname: string | null;
  ingestStatus: string;
  errorMessage: string | null;
  createdAt: Date;
  /** Present on full rows. Only the marker check leaves the server. */
  extractedText?: string | null;
  /** Precomputed marker check for list queries that do not load the text. */
  hasPageMarkers?: boolean | null;
}, sourceUrl: string | null) {
  return {
    id: row.id,
    reviewerId: row.reviewerId,
    filename: row.filename,
    mime: row.mime,
    kind: row.kind,
    // Never expose the provider URL. Reads go through the owner-authenticated
    // source route, which keeps private Blob URLs out of the browser.
    blob_url: sourceUrl,
    blob_pathname: row.blobPathname,
    blobUrl: sourceUrl,
    blobPathname: row.blobPathname,
    ingest_status: row.ingestStatus,
    ingestStatus: row.ingestStatus,
    error_message: publicSourceErrorMessage(row.errorMessage),
    errorMessage: publicSourceErrorMessage(row.errorMessage),
    createdAt: row.createdAt.toISOString(),
    // null means unknown: the row was loaded without its extracted text.
    hasPageMarkers: typeof row.hasPageMarkers === "boolean"
      ? row.hasPageMarkers
      : row.extractedText !== undefined
        ? hasPageMarkers(row.extractedText)
        : null,
  };
}
