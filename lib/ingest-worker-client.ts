import "server-only";

import { Worker } from "node:worker_threads";

import { PublicError } from "@/lib/public-errors";

/** V8 heap ceiling for the killable parser worker; the worker also checks RSS. */
const PDF_WORKER_MAX_OLD_GENERATION_MB = 1024;

/** One parser at the raised ceiling. Parallel workers would exhaust the function. */
export const MAX_PARSER_WORKERS = 1;
export const MAX_PARSER_QUEUE = 32;

type ParserResult =
  | { ok: true; text: string }
  | {
      ok: false;
      errorKind:
        | "office"
        | "pdf-text"
        | "pdf-page-limit"
        | "pdf-page-count"
        | "pdf-text-limit"
        | "pdf-output-limit"
        | "pdf-memory-limit";
    };

type ParserArgs = {
  kind: "office" | "pdf-text";
  format?: "document" | "presentation";
  bytes: Uint8Array;
  signal: AbortSignal;
};

const parserQueue: Array<{
  args: ParserArgs;
  started: boolean;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}> = [];
let activeParserWorkers = 0;

function killedParserError(kind: ParserArgs["kind"], fallback: string): PublicError {
  return new PublicError(
    kind === "pdf-text" ? "PDF parser exceeded the safe memory limit" : fallback,
  );
}

function runParserWorker(args: ParserArgs): Promise<string> {
  if (args.signal.aborted) {
    return Promise.reject(new PublicError("Source ingest cancelled"));
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./ingest-worker.ts", import.meta.url), {
      resourceLimits: {
        maxOldGenerationSizeMb: PDF_WORKER_MAX_OLD_GENERATION_MB,
      },
    });
  } catch {
    return Promise.reject(new PublicError("Parser worker failed"));
  }

  let settled = false;
  const stop = async () => {
    if (settled) return;
    settled = true;
    await worker.terminate();
  };
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      void stop().finally(() => reject(new PublicError("Source ingest cancelled")));
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      args.signal.removeEventListener("abort", onAbort);
      callback();
      void worker.terminate();
    };
    worker.once("message", (result: ParserResult) => {
      finish(() => {
        if (result.ok) resolve(result.text);
        else reject(new PublicError(
          result.errorKind === "office"
            ? "Office parser failed"
            : result.errorKind === "pdf-page-limit"
              ? "PDF exceeds the 100-page limit"
              : result.errorKind === "pdf-page-count"
                ? "PDF page count is invalid"
                : result.errorKind === "pdf-text-limit"
                  ? "PDF extracted text exceeds the safe character limit"
                  : result.errorKind === "pdf-output-limit"
                    ? "PDF extracted output exceeds the safe size limit"
                    : result.errorKind === "pdf-memory-limit"
                      ? "PDF parser exceeded the safe memory limit"
                      : "PDF parser failed",
        ));
      });
    });
    worker.once("error", () => {
      finish(() => reject(killedParserError(args.kind, "Parser worker failed")));
    });
    worker.once("exit", (code) => {
      if (code !== 0 || !settled) {
        finish(() => reject(killedParserError(args.kind, "Parser worker stopped unexpectedly")));
      }
    });
    args.signal.addEventListener("abort", onAbort, { once: true });
    const transferable = args.bytes.slice();
    try {
      worker.postMessage(
        { kind: args.kind, format: args.format, bytes: transferable },
        [transferable.buffer],
      );
    } catch {
      finish(() => reject(new PublicError("Parser worker failed")));
    }
  });
}

function pumpParserQueue(): void {
  while (activeParserWorkers < MAX_PARSER_WORKERS && parserQueue.length > 0) {
    const pending = parserQueue.shift();
    if (!pending) return;
    pending.started = true;
    pending.args.signal.removeEventListener("abort", pending.onAbort);
    if (pending.args.signal.aborted) {
      pending.reject(new PublicError("Source ingest cancelled"));
      continue;
    }
    activeParserWorkers += 1;
    void Promise.resolve()
      .then(() => runParserWorker(pending.args))
      .then(pending.resolve, pending.reject)
      .finally(() => {
        activeParserWorkers -= 1;
        pumpParserQueue();
      });
  }
}

/**
 * Run parser code outside the request thread. A deadline abort terminates the
 * worker, rather than awaiting a non-cooperative library after cancellation.
 * Next bundles this `new URL` worker entry as a server asset. A small FIFO
 * queue bounds total parser concurrency under parallel uploads.
 */
export function runKillableParser(args: ParserArgs): Promise<string> {
  if (args.signal.aborted) {
    return Promise.reject(new PublicError("Source ingest cancelled"));
  }
  if (activeParserWorkers >= MAX_PARSER_WORKERS && parserQueue.length >= MAX_PARSER_QUEUE) {
    return Promise.reject(new PublicError("Parser worker queue is full"));
  }

  return new Promise<string>((resolve, reject) => {
    const pending = {
      args,
      started: false,
      resolve,
      reject,
      onAbort: () => {
        if (pending.started) return;
        const index = parserQueue.indexOf(pending);
        if (index >= 0) parserQueue.splice(index, 1);
        args.signal.removeEventListener("abort", pending.onAbort);
        reject(new PublicError("Source ingest cancelled"));
        pumpParserQueue();
      },
    };
    args.signal.addEventListener("abort", pending.onAbort, { once: true });
    parserQueue.push(pending);
    pumpParserQueue();
  });
}
