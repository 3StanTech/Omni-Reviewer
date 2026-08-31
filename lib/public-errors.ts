/**
 * Errors whose message has been deliberately authored for the caller.
 * Unexpected provider, SDK, and runtime errors must never cross an API
 * boundary with their raw message because they may contain sensitive detail.
 */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicError";
  }
}

export function isPublicError(error: unknown): error is PublicError {
  return error instanceof PublicError;
}

export function publicErrorMessage(error: unknown, fallback: string): string {
  return isPublicError(error) && error.message.trim()
    ? error.message
    : fallback;
}

const GENERIC_SOURCE_ERROR = "Source processing failed.";
const SAFE_SOURCE_ERRORS = new Set([
  "Vision readout returned empty text",
  "PDF has no extractable text and cannot be rasterized in v1",
  "PDF has no extractable text or embedded page images.",
  "PDF vision fallback returned empty text.",
  "PDF vision fallback timed out",
  "PDF vision fallback is limited to the first 5 pages",
  "PDF page images exceed the safe vision byte limit",
  "PDF page count is invalid",
  "PDF exceeds the 100-page limit",
  "PDF extracted text exceeds the safe character limit",
  "PDF extracted output exceeds the safe size limit",
  "PDF parser exceeded the safe memory limit",
  "PDF page image exceeds the safe pixel limit.",
  "PDF page image uses an unsupported color format.",
  "PDF page image data is malformed.",
  "Image vision readout failed",
  "PDF text extraction failed",
  "PDF text and vision extraction failed",
  "Text extraction failed",
  "Invalid private Blob identity",
  "Source ingest timed out",
  "Source ingest cancelled",
  "Source ingest aborted",
  "Scanned PDF vision fallback is unavailable in this deployment; upload a text PDF or paste the text.",
  "Office parser failed",
  "PDF parser failed",
  "Parser worker failed",
  "Parser worker queue is full",
  "DOCX contains no supported content.",
  "DOCX contains no extractable text.",
  "PPTX contains no supported content.",
  "PPTX contains no extractable text.",
  "Office archive contains an invalid filename.",
  "Office archive is truncated or malformed.",
  "Office archive has no valid directory.",
  "Office archive uses unsupported ZIP features.",
  "Office archive directory is outside the archive.",
  "Office archive directory is malformed.",
  "Office archive contains unsupported or unsafe entries.",
  "Office archive contains an unsafe path.",
  "Office archive contains duplicate entries.",
  "Office archive contains a symbolic link.",
  "Office archive entry exceeds the safe size limit.",
  "Office archive has an unsafe compression ratio.",
  "Office archive exceeds the safe expansion limit.",
  "Office archive local entry is malformed.",
  "Office archive local entry does not match its directory.",
  "Office archive contains invalid compressed data.",
  "Office archive entry size does not match its directory.",
  "DOCX extracted text exceeds the safe character limit.",
  "PPTX extracted text exceeds the safe character limit.",
  "Office XML exceeds the safe byte limit.",
  "Office XML text exceeds the safe character limit.",
  "Office XML tag exceeds the safe size limit.",
  "Office XML exceeds the safe node limit.",
  "Office XML contains an unsupported declaration.",
  "Office XML is malformed.",
  "Paste text is required",
  "Paste text exceeds the 200,000 character limit",
  "Paste title is required",
  "Paste title exceeds the 180 character limit",
]);

/** Sanitize source error strings that may have been persisted by older code. */
export function publicSourceErrorMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  if (SAFE_SOURCE_ERRORS.has(message)) return message;
  if (/^Blob exceeds the \d+ MiB limit$/.test(message)) return message;
  if (/^Blob content type [\w.+/-]+ does not match declared mime [\w.+/-]+$/.test(message)) {
    return message;
  }
  return GENERIC_SOURCE_ERROR;
}

const SAFE_LOG_CONTEXTS = new Set([
  "Ingest cleanup failed",
  "Source ingest failed",
  "Invalid runtime environment",
  "Blob lifecycle operation failed",
  "Blob deletion failed",
  "Blob reconciliation failed",
  "Blob upload handshake failed",
  "Topic deletion failed",
  "Reviewer deletion failed",
  "Generation step failed",
  "Could not save pasted text",
  "Private source retrieval failed",
  "Blob cleanup database operation failed",
  "Unregistered Blob reservation release failed",
  "Unregistered Blob cleanup deferred",
  "Unregistered Blob cleanup failed",
  "Blob reservation failed",
  "Blob verification failed",
  "Could not save source",
]);

const SAFE_LOG_DETAIL_KEYS = new Set([
  "userId",
  "reviewerId",
  "topicId",
  "sourceId",
  "jobId",
  "step",
  "providerStatus",
  "providerCode",
  "requestId",
  "invalidKeys",
]);

const UUID_DETAIL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_DETAIL_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:req|request|trace|x-request-id|chatcmpl|run|gen)[-_][A-Za-z0-9_-]{1,96})$/i;
const SAFE_INVALID_KEYS_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}(?:,[A-Za-z][A-Za-z0-9_.-]{0,63})*$/;
const SAFE_STEPS = new Set(["locked_in", "summary", "test_me", "carded"]);
const SAFE_PROVIDER_CODES = new Map(
  [
    "payment_required",
    "rate_limited",
    "unavailable",
    "token_limit",
    "json_parse",
    "timeout",
    "unknown",
    "stale",
    "context_length_exceeded",
    "insufficient_quota",
    "rate_limit_exceeded",
    "rate_limit",
    "too_many_requests",
    "invalid_request_error",
    "server_error",
    "overloaded_error",
    "internal_server_error",
    "service_unavailable",
    "gateway_timeout",
    "fetch_failed",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EAI_AGAIN",
  ].map((code) => [code.toLowerCase(), code] as const),
);

const SAFE_ERROR_TYPES = new Set([
  "Error",
  "AggregateError",
  "AbortError",
  "EvalError",
  "GenerationError",
  "NeonDbError",
  "NoObjectGeneratedError",
  "PromptInputLimitError",
  "PublicError",
  "RangeError",
  "ReferenceError",
  "StudyPackJsonError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
  "ZodError",
  "BlobNotFoundError",
]);

type RedactedLogDetail = string | number | boolean | null | undefined;

function sanitizeLogDetails(
  details: Record<string, RedactedLogDetail>,
): Record<string, string | number> {
  const output: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_LOG_DETAIL_KEYS.has(key)) continue;

    if (/^(?:user|reviewer|topic|source|job)Id$/.test(key)) {
      if (typeof value === "string" && UUID_DETAIL_RE.test(value)) {
        output[key] = value;
      }
      continue;
    }

    if (key === "providerStatus") {
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
        output[key] = value;
      }
      continue;
    }

    if (key === "providerCode") {
      if (typeof value === "string") {
        const canonical = SAFE_PROVIDER_CODES.get(value.trim().toLowerCase());
        if (canonical) output[key] = canonical;
      }
      continue;
    }

    if (key === "requestId") {
      if (typeof value === "string") {
        const requestId = value.trim();
        if (requestId.length <= 128 && REQUEST_ID_DETAIL_RE.test(requestId)) {
          output[key] = requestId;
        }
      }
      continue;
    }

    if (key === "step") {
      if (typeof value === "string" && SAFE_STEPS.has(value)) output[key] = value;
      continue;
    }

    if (key === "invalidKeys") {
      if (typeof value === "string" && value.length <= 1024 && SAFE_INVALID_KEYS_RE.test(value)) {
        output[key] = value;
      }
    }
  }

  return output;
}

/** Log only allowlisted metadata, never raw messages, bodies, or stacks. */
export function logRedactedError(
  context: string,
  error: unknown,
  details: Record<string, RedactedLogDetail> = {},
): void {
  const errorType =
    error instanceof Error && SAFE_ERROR_TYPES.has(error.name)
      ? error.name
      : error instanceof Error
        ? "Error"
        : typeof error;
  console.error(
    SAFE_LOG_CONTEXTS.has(context) ? context : "Application error",
    { ...sanitizeLogDetails(details), errorType },
  );
}
