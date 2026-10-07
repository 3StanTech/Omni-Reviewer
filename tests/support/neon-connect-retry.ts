import { neonConfig } from "@neondatabase/serverless";

type Fetch = typeof fetch;

/** Undici reports a connection that never opened with this code (10 s default from this Mac). */
function isConnectTimeout(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return cause?.code === "UND_ERR_CONNECT_TIMEOUT";
}

/**
 * A fetch that retries only when the TCP connection never opened, so no query
 * reached the database and a retry cannot run it twice.
 */
export function connectRetryFetch(base: Fetch, attempts = 3): Fetch {
  return async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await base(input, init);
      } catch (error) {
        if (attempt >= attempts || !isConnectTimeout(error)) throw error;
      }
    }
  };
}

/** Vitest setup for the live Neon suites (RUN_DB_INTEGRATION=1 only). */
export function installNeonConnectRetry(): void {
  neonConfig.fetchFunction = connectRetryFetch(globalThis.fetch.bind(globalThis));
}
