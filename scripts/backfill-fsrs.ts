/**
 * Sets FSRS state on every card that has none, by replaying its reviews.
 *
 * Usage (direct, non-pooler Neon URL from the runner env):
 *   DATABASE_URL=... npm run db:backfill-fsrs
 *
 * Runs as `tsx --conditions=react-server` so `server-only` resolves. Reruns are
 * no-ops: every UPDATE requires `fsrs_state IS NULL`. Prints counts only.
 */

import { backfillFsrs } from "../lib/queries";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL is not set");
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    fail("DATABASE_URL is not a valid URL");
  }
  if (!host || host.includes("-pooler")) {
    fail("DATABASE_URL must be a direct (non-pooler) Neon host");
  }
  const counts = await backfillFsrs();
  console.log(
    `FSRS backfill: scanned ${counts.scanned}, replayed ${counts.replayed}, new ${counts.markedNew}, skipped ${counts.skipped}`,
  );
}

main().catch((error: unknown) => {
  const url = process.env.DATABASE_URL;
  let message = error instanceof Error ? error.message : String(error);
  if (url) message = message.split(url).join("<DATABASE_URL>");
  console.error(`FSRS backfill failed: ${message}`);
  process.exit(1);
});
