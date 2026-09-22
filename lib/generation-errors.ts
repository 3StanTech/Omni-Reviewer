import { PromptInputLimitError } from "@/lib/prompts";
import { GenerationBudgetError } from "@/lib/ai-budgets";

export type GenerationErrorCode =
  | "payment_required"
  | "rate_limited"
  | "unavailable"
  | "token_limit"
  | "json_parse"
  | "timeout"
  | "unknown";

export type ClassifiedGenerationError = {
  code: GenerationErrorCode;
  message: string;
  retryable: boolean;
};

export type ParsedProviderError = {
  status?: number;
  code?: string;
  message: string;
  requestId?: string;
};

const UNKNOWN_GENERATION_MESSAGE =
  "Generation failed unexpectedly. Try again shortly.";

const PUBLIC_GENERATION_MESSAGES: Record<string, string> = {
  payment_required:
    "Generation credits are exhausted. Try again later or check your OpenRouter balance.",
  rate_limited: "The model is rate limited right now. Wait a moment and try again.",
  unavailable: "The model provider is temporarily unavailable. Try again shortly.",
  token_limit:
    "The source material is too long for this model. Split sources or shorten Locked In content.",
  timeout: "Generation timed out. Try again in a moment.",
  json_parse: "The model returned invalid structured data after repair. Try generating again.",
  unknown: UNKNOWN_GENERATION_MESSAGE,
  stale: "Study content changed while generating. Refresh and confirm overwrite.",
};

/**
 * Return only an authored message for a persisted error code. The database
 * may contain rows written by older code, so never trust error_message alone
 * at an API boundary.
 */
export function publicGenerationErrorMessage(
  code: string | null | undefined,
  message: string | null | undefined,
): string | null {
  if (!code && !message) return null;
  return PUBLIC_GENERATION_MESSAGES[code ?? "unknown"] ?? UNKNOWN_GENERATION_MESSAGE;
}

export class GenerationError extends Error {
  readonly code: GenerationErrorCode;
  readonly retryable: boolean;

  constructor(code: GenerationErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "GenerationError";
    this.code = code;
    this.retryable = retryable;
  }

  toJSON(): ClassifiedGenerationError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

const MAX_PROVIDER_PARSE_DEPTH = 5;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function findNumber(
  value: unknown,
  keys: readonly string[],
  depth = 0,
  seen = new Set<object>(),
): number | undefined {
  if (depth > MAX_PROVIDER_PARSE_DEPTH) return undefined;
  const parsed = parseJsonString(value);
  const record = asRecord(parsed);
  if (!record) return undefined;
  if (seen.has(record)) return undefined;
  seen.add(record);

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) {
      return Number(candidate);
    }
  }

  for (const candidate of Object.values(record)) {
    const nested = findNumber(candidate, keys, depth + 1, seen);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findString(
  value: unknown,
  keys: readonly string[],
  depth = 0,
  seen = new Set<object>(),
): string | undefined {
  if (depth > MAX_PROVIDER_PARSE_DEPTH) return undefined;
  const parsed = parseJsonString(value);
  const record = asRecord(parsed);
  if (!record) return typeof parsed === "string" ? parsed.trim() || undefined : undefined;
  if (seen.has(record)) return undefined;
  seen.add(record);

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  for (const candidate of Object.values(record)) {
    const nested = findString(candidate, keys, depth + 1, seen);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Find a string only when it is stored under one of the supplied keys. Unlike
 * findString, this deliberately does not treat arbitrary primitive leaves as
 * the answer; provider payloads are untrusted input.
 */
function findNamedString(
  value: unknown,
  keys: readonly string[],
  depth = 0,
  seen = new Set<object>(),
): string | undefined {
  if (depth > MAX_PROVIDER_PARSE_DEPTH) return undefined;
  const parsed = parseJsonString(value);
  const record = asRecord(parsed);
  if (!record) return undefined;
  if (seen.has(record)) return undefined;
  seen.add(record);

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  for (const candidate of Object.values(record)) {
    const nested = findNamedString(candidate, keys, depth + 1, seen);
    if (nested) return nested;
  }
  return undefined;
}

const SAFE_PROVIDER_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safeProviderIdentifier(value: string | undefined): string | undefined {
  if (!value || value.length > 128 || !SAFE_PROVIDER_IDENTIFIER_RE.test(value)) {
    return undefined;
  }
  return value;
}

function responseHeader(error: Record<string, unknown>, name: string): string | undefined {
  const headers = error.responseHeaders;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const record = asRecord(headers);
  if (!record) return undefined;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Extract the useful fields from AI SDK / OpenRouter errors, including JSON
 * response bodies nested in responseBody, data, cause, or error properties.
 * Raw provider payloads are deliberately not returned to callers.
 */
export function parseProviderError(err: unknown): ParsedProviderError {
  const root = asRecord(err);
  const body = root?.responseBody ?? root?.data ?? root?.body;
  const status =
    findNumber(err, ["statusCode", "status", "httpStatus", "code"]) ??
    findNumber(body, ["statusCode", "status", "httpStatus", "code"]);
  const message =
    findString(body, ["message", "detail", "error_description"]) ||
    findString(err, ["message", "detail", "error_description"]) ||
    (typeof err === "string" && err.trim() ? err.trim() : "Generation failed");
  const codeValue =
    findNamedString(body, ["type", "errorCode", "error_code", "code"]) ??
    findNamedString(err, ["type", "errorCode", "error_code", "code"]);
  const code =
    codeValue && !/^\d+$/.test(codeValue)
      ? safeProviderIdentifier(codeValue)
      : undefined;
  const requestIdValue =
    (root ? responseHeader(root, "x-request-id") : undefined) ??
    findNamedString(err, ["requestId", "request_id"]);
  const requestId = safeProviderIdentifier(requestIdValue);

  return { status, code, message, requestId };
}

function statusFromError(err: unknown): number | undefined {
  return parseProviderError(err).status;
}

function messageFromError(err: unknown): string {
  return parseProviderError(err).message;
}

function bodyText(err: unknown): string {
  const parsed = parseProviderError(err);
  return `${parsed.code ?? ""} ${parsed.message}`.toLowerCase();
}

const TRANSIENT_PROVIDER_STATUSES = new Set([500, 502, 503, 504]);

function hasKnownNetworkTransportFailure(parsed: ParsedProviderError): boolean {
  const text = `${parsed.code ?? ""} ${parsed.message}`;
  return /(?:fetch failed|\bECONNRESET\b|\bECONNREFUSED\b|\bENETUNREACH\b|\bEAI_AGAIN\b)/i.test(
    text,
  );
}

function hasNetworkTimeout(parsed: ParsedProviderError, err: unknown): boolean {
  const text = `${parsed.code ?? ""} ${parsed.message}`;
  return (
    /\bETIMEDOUT\b/i.test(text) ||
    /timeout|timed out|deadline/i.test(text) ||
    (err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError"))
  );
}

/** Map provider / runtime errors into a stable client-facing shape. */
export function classifyGenerationError(err: unknown): ClassifiedGenerationError {
  if (err instanceof GenerationError) {
    return err.toJSON();
  }

  if (err instanceof PromptInputLimitError) {
    return {
      code: "token_limit",
      message: PUBLIC_GENERATION_MESSAGES.token_limit,
      retryable: false,
    };
  }

  if (err instanceof GenerationBudgetError) {
    return {
      code: "token_limit",
      message: PUBLIC_GENERATION_MESSAGES.token_limit,
      retryable: false,
    };
  }

  const parsed = parseProviderError(err);
  const status = parsed.status ?? statusFromError(err);
  const message = messageFromError(err);
  const body = `${message} ${bodyText(err)}`.toLowerCase();

  if (
    status === 402 ||
    body.includes("payment required") ||
    body.includes("insufficient credits") ||
    body.includes("insufficient_quota")
  ) {
    return {
      code: "payment_required",
      message: PUBLIC_GENERATION_MESSAGES.payment_required,
      retryable: false,
    };
  }

  if (
    status === 429 ||
    body.includes("rate limit") ||
    body.includes("rate_limit") ||
    body.includes("too many requests")
  ) {
    return {
      code: "rate_limited",
      message: PUBLIC_GENERATION_MESSAGES.rate_limited,
      retryable: true,
    };
  }

  if (
    TRANSIENT_PROVIDER_STATUSES.has(status ?? -1) ||
    body.includes("unavailable") ||
    body.includes("overloaded") ||
    hasKnownNetworkTransportFailure(parsed)
  ) {
    return {
      code: "unavailable",
      message: PUBLIC_GENERATION_MESSAGES.unavailable,
      retryable: true,
    };
  }

  if (
    status === 400 &&
    (body.includes("token") ||
      body.includes("context length") ||
      body.includes("context_length") ||
      body.includes("context_length_exceeded") ||
      body.includes("maximum context") ||
      body.includes("too long") ||
      body.includes("token_limit"))
  ) {
    return {
      code: "token_limit",
      message: PUBLIC_GENERATION_MESSAGES.token_limit,
      retryable: false,
    };
  }

  if (hasNetworkTimeout(parsed, err)) {
    return {
      code: "timeout",
      message: PUBLIC_GENERATION_MESSAGES.timeout,
      retryable: true,
    };
  }

  if (
    body.includes("json") ||
    body.includes("parse") ||
    body.includes("structured output") ||
    err instanceof SyntaxError ||
    (err instanceof Error && err.name === "StudyPackJsonError")
  ) {
    return {
      code: "json_parse",
      message: PUBLIC_GENERATION_MESSAGES.json_parse,
      retryable: true,
    };
  }

  return {
    code: "unknown",
    message: PUBLIC_GENERATION_MESSAGES.unknown,
    retryable: false,
  };
}

export function toGenerationError(err: unknown): GenerationError {
  if (err instanceof GenerationError) return err;
  const classified = classifyGenerationError(err);
  return new GenerationError(
    classified.code,
    classified.message,
    classified.retryable,
  );
}
