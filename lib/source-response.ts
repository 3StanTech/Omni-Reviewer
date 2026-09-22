import { publicSourceErrorMessage } from "@/lib/public-errors";

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
  };
}
