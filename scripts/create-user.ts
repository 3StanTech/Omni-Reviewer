/**
 * Invite a user (no public signup).
 *
 * Usage:
 *   npx tsx scripts/create-user.ts email@example.com 'password' [name]
 *   npx tsx scripts/create-user.ts email@example.com 'password' --bootstrap
 *   npx tsx scripts/create-user.ts email@example.com 'password' 'Display Name' --bootstrap
 *
 * --bootstrap: after insert, assign orphaned rows (null user_id) to this user.
 * Useful when migrating an existing DB where user_id was added as nullable.
 *
 * Operator order for a fresh install:
 * 1. npm run db:push with Neon DIRECT / unpooled DATABASE_URL (pooler cannot run migrations).
 * 2. Create the first user with this script.
 * 3. Sign in; create topics only after a user exists.
 *
 * If topics already exist without owners, push user_id as nullable, run with
 * --bootstrap, then tighten to not null.
 */

import { neon } from "@neondatabase/serverless";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";

import { hashPassword } from "../lib/auth-utils";
import { generationJobs, topics, users } from "../lib/schema";

function usage(): never {
  console.error(
    "Usage: npx tsx scripts/create-user.ts <email> <password> [name] [--bootstrap]",
  );
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a.length > 0);
  const bootstrap = args.includes("--bootstrap");
  const positional = args.filter((a) => a !== "--bootstrap");

  const emailRaw = positional[0];
  const password = positional[1];
  const nameArg = positional[2];

  if (!emailRaw || !password) {
    usage();
  }

  const email = emailRaw.trim().toLowerCase();
  if (!email.includes("@")) {
    console.error("email looks invalid");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const name =
    typeof nameArg === "string" && nameArg.trim().length > 0
      ? nameArg.trim()
      : null;

  const passwordHash = await hashPassword(password);
  const sqlClient = neon(databaseUrl);
  const db = drizzle(sqlClient, {
    schema: { users, topics, generationJobs },
  });

  const existing = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing[0]) {
    console.error(`User already exists: ${existing[0].email} (${existing[0].id})`);
    process.exit(1);
  }

  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      name,
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      createdAt: users.createdAt,
    });

  console.log(`Created user ${user.email} (${user.id})`);

  if (bootstrap) {
    // Raw SQL so this still works when columns are temporarily nullable.
    await db.execute(
      sql`update topics set user_id = ${user.id} where user_id is null`,
    );
    await db.execute(
      sql`update generation_jobs set user_id = ${user.id} where user_id is null`,
    );
    console.log(
      `Bootstrap: assigned orphaned topics and generation_jobs (if any) to ${user.id}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
