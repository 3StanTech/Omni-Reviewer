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

function statusFromError(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const obj = err as Record<string, unknown>;
  if (typeof obj.statusCode === "number") return obj.statusCode;
  if (typeof obj.status === "number") return obj.status;
  if (obj.cause && typeof obj.cause === "object") {
    const cause = obj.cause as Record<string, unknown>;
    if (typeof cause.statusCode === "number") return cause.statusCode;
    if (typeof cause.status === "number") return cause.status;
  }
  return undefined;
}

function messageFromError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Generation failed";
}

function bodyText(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const obj = err as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.message === "string") parts.push(obj.message);
  if (typeof obj.responseBody === "string") parts.push(obj.responseBody);
  if (typeof obj.data === "string") parts.push(obj.data);
  return parts.join(" ").toLowerCase();
}

/** Map provider / runtime errors into a stable client-facing shape. */
export function classifyGenerationError(err: unknown): ClassifiedGenerationError {
  if (err instanceof GenerationError) {
    return err.toJSON();
  }

  const status = statusFromError(err);
  const message = messageFromError(err);
  const body = `${message} ${bodyText(err)}`.toLowerCase();

  if (status === 402 || body.includes("payment required") || body.includes("insufficient credits")) {
    return {
      code: "payment_required",
      message: "Generation credits are exhausted. Try again later or check your OpenRouter balance.",
      retryable: false,
    };
  }

  if (status === 429 || body.includes("rate limit") || body.includes("too many requests")) {
    return {
      code: "rate_limited",
      message: "The model is rate limited right now. Wait a moment and try again.",
      retryable: true,
    };
  }

  if (status === 503 || body.includes("unavailable") || body.includes("overloaded")) {
    return {
      code: "unavailable",
      message: "The model provider is temporarily unavailable. Try again shortly.",
      retryable: true,
    };
  }

  if (
    status === 400 &&
    (body.includes("token") ||
      body.includes("context length") ||
      body.includes("context_length") ||
      body.includes("maximum context") ||
      body.includes("too long"))
  ) {
    return {
      code: "token_limit",
      message: "The source material is too long for this model. Split sources or shorten Locked In content.",
      retryable: false,
    };
  }

  if (
    body.includes("timeout") ||
    body.includes("timed out") ||
    body.includes("deadline") ||
    (err instanceof Error && err.name === "TimeoutError")
  ) {
    return {
      code: "timeout",
      message: "Generation timed out. Try again in a moment.",
      retryable: true,
    };
  }

  if (
    body.includes("json") ||
    body.includes("parse") ||
    err instanceof SyntaxError ||
    (err instanceof Error && err.name === "StudyPackJsonError")
  ) {
    return {
      code: "json_parse",
      message: "The model returned invalid structured data after repair. Try generating again.",
      retryable: true,
    };
  }

  return {
    code: "unknown",
    message,
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
