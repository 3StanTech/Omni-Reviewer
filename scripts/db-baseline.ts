/**
 * Record drizzle/0000_baseline as already applied on a database that was built
 * with `drizzle-kit push`, so `npm run db:migrate` applies only later migrations.
 *
 * Usage (direct, non-pooler Neon URL):
 *   DATABASE_URL=... npm run db:baseline
 *
 * Steps:
 * 1. Refuse a pooler host (`-pooler` in the hostname).
 * 2. If drizzle.__drizzle_migrations already holds the baseline hash, print
 *    `already recorded` and stop. That keeps reruns no-ops after later
 *    migrations change the schema.
 * 3. Drift check. drizzle-kit 0.31 has no non-interactive dry run for push:
 *    `push --strict` always prompts, and `drizzle-kit/api` `pushSchema` diffs
 *    against the current lib/schema.ts (not the baseline) and can prompt on
 *    renames. So this script reads pg_catalog for schema `public` and compares
 *    it to drizzle/meta/0000_snapshot.json (see `schemaDrift` in
 *    scripts/migration-hash.ts). Any difference exits non-zero.
 * 4. Create schema `drizzle` and table `__drizzle_migrations` with the same DDL
 *    as drizzle-orm 0.45 pg-core `dialect.migrate` / neon-http `migrate`
 *    (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint), then
 *    insert (hash = sha256 of the baseline SQL file, created_at = journal
 *    `when`) if absent. The migrator applies every entry whose `when` is
 *    greater than the latest recorded created_at.
 *
 * DDL runs only for drizzle's own schema and table; app tables are never touched.
 * The database URL is never printed.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import {
  baselineRecord,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  pgTextArray,
  readSnapshot,
  schemaDrift,
  type LiveSchema,
} from "./migration-hash";

const MIGRATIONS = `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`;

type Sql = NeonQueryFunction<false, false>;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readLiveSchema(sql: Sql): Promise<LiveSchema> {
  const [columns, primaryKeys, constraints, indexes, enums] = await Promise.all([
    sql.query(`
      select c.relname as "table", a.attname as "column",
        case when t.typtype = 'e' then t.typname
             else format_type(a.atttypid, a.atttypmod) end as "type",
        a.attnotnull as "notNull", a.atthasdef as "hasDefault"
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_type t on t.oid = a.atttypid
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and a.attnum > 0 and not a.attisdropped`),
    sql.query(`
      select c.relname as "table", a.attname as "column"
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
      where n.nspname = 'public' and k.contype = 'p'`),
    sql.query(`
      select c.relname as "table", k.conname as "name", k.contype as "kind"
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and k.contype in ('u', 'f', 'c')`),
    sql.query(`
      select t.relname as "table", i.relname as "name", x.indisunique as "isUnique"
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and not exists (
          select 1 from pg_constraint k
          where k.conindid = x.indexrelid and k.contype in ('p', 'u', 'x')
        )`),
    sql.query(`
      select t.typname as "name",
        json_agg(e.enumlabel::text order by e.enumsortorder) as "values"
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      group by t.typname`),
  ]);
  return {
    columns: columns as LiveSchema["columns"],
    primaryKeys: primaryKeys as LiveSchema["primaryKeys"],
    constraints: constraints as LiveSchema["constraints"],
    indexes: indexes as LiveSchema["indexes"],
    // Neon HTTP returns name[] as a "{a,b}" string; json_agg plus
    // pgTextArray keeps enum values a real string array either way.
    enums: (enums as { name: string; values: unknown }[]).map((e) => ({
      name: e.name,
      values: pgTextArray(e.values),
    })),
  };
}

async function recordedHashes(sql: Sql): Promise<string[] | null> {
  const [reg] = (await sql.query(`select to_regclass($1) as "reg"`, [
    MIGRATIONS,
  ])) as { reg: string | null }[];
  if (!reg?.reg) return null;
  const rows = (await sql.query(`select hash from ${MIGRATIONS}`)) as {
    hash: string;
  }[];
  return rows.map((r) => r.hash);
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

  const baseline = baselineRecord();
  const sql = neon(databaseUrl);

  const hashes = await recordedHashes(sql);
  if (hashes?.includes(baseline.hash)) {
    console.log("already recorded");
    return;
  }
  if (hashes && hashes.length > 0) {
    fail(
      `${MIGRATIONS} has ${hashes.length} row(s) but none is ${baseline.tag}; refusing to record the baseline`,
    );
  }

  const drift = schemaDrift(readSnapshot(baseline.tag), await readLiveSchema(sql));
  if (drift.length > 0) {
    console.error(`Schema drift against ${baseline.tag}; baseline not recorded:`);
    for (const line of drift) console.error(`  ${line}`);
    process.exit(1);
  }

  const results = await sql.transaction([
    sql.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`),
    sql.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS} (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`),
    sql.query(
      `insert into ${MIGRATIONS} ("hash", "created_at")
       select $1, $2
       where not exists (select 1 from ${MIGRATIONS} where hash = $1)
       returning id`,
      [baseline.hash, baseline.createdAt],
    ),
  ]);
  const inserted = results[2] as unknown[];
  console.log(inserted.length > 0 ? "baseline recorded" : "already recorded");
}

main().catch((err) => {
  const url = process.env.DATABASE_URL;
  let message = err instanceof Error ? err.message : String(err);
  if (url) {
    message = message.split(url).join("<DATABASE_URL>");
    try {
      const { hostname, password } = new URL(url);
      if (password) message = message.split(password).join("<redacted>");
      if (hostname) message = message.split(hostname).join("<host>");
    } catch {
      // Unparseable URL was already rejected in main.
    }
  }
  console.error(message);
  process.exit(1);
});
