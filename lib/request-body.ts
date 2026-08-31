import { PublicError, publicErrorMessage } from "@/lib/public-errors";

export const MAX_MUTATION_BODY_BYTES = 1_000_000;
export const MAX_GENERATE_BODY_BYTES = 256 * 1024;
export const MAX_TEST_ATTEMPT_BODY_BYTES = 2_500_000;
export const MAX_UPLOAD_HANDSHAKE_BODY_BYTES = 64 * 1024;

export function cappedBodyError(
  error: unknown,
  fallback = "Invalid JSON body",
): { message: string; status: 400 | 413 } {
  const message = publicErrorMessage(error, fallback);
  return {
    message,
    status: /exceeds .*size limit|body is too large|request is too large/i.test(message)
      ? 413
      : 400,
  };
}

type CappedBodyOptions = {
  maxBytes: number;
  tooLargeMessage: string;
  invalidMessage?: string;
  allowEmpty?: boolean;
};

/** Read a request body only after enforcing a byte cap on declared/streamed input. */
async function readCappedBytes(
  request: Request,
  args: CappedBodyOptions,
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new PublicError(args.invalidMessage ?? "Invalid request body");
    }
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > args.maxBytes) {
      throw new PublicError(args.tooLargeMessage);
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    if (args.allowEmpty) return new Uint8Array();
    throw new PublicError(args.invalidMessage ?? "Invalid request body");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > args.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PublicError(args.tooLargeMessage);
      }
      chunks.push(next.value);
    }
  } finally {
    request.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read capped UTF-8 text for endpoints whose body is not parsed as JSON. */
export async function readCappedText(
  request: Request,
  args: CappedBodyOptions,
): Promise<string> {
  const bytes = await readCappedBytes(request, args);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PublicError(args.invalidMessage ?? "Invalid request body");
  }
}

/** Read JSON only after enforcing a byte cap on both declared and streamed input. */
export async function readCappedJson(
  request: Request,
  args: CappedBodyOptions,
): Promise<unknown> {
  const raw = await readCappedText(request, {
    ...args,
    invalidMessage: args.invalidMessage ?? "Invalid JSON body",
  });
  if (!raw.trim()) throw new PublicError(args.invalidMessage ?? "Invalid JSON body");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new PublicError(args.invalidMessage ?? "Invalid JSON body");
  }
}
