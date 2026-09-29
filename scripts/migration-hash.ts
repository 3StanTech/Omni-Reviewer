/**
 * Pure helpers shared by scripts/db-baseline.ts and tests/migrations.test.ts.
 *
 * Mirrors drizzle-orm 0.45 `readMigrationFiles` (node_modules/drizzle-orm/migrator.js):
 * each journal entry's `<tag>.sql` is hashed as sha256 hex of the whole file text,
 * and the recorded `created_at` is the journal entry's `when`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const MIGRATIONS_FOLDER = path.resolve(__dirname, "..", "drizzle");

/** Defaults of pg-core `dialect.migrate` and neon-http `migrate`. */
export const MIGRATIONS_SCHEMA = "drizzle";
export const MIGRATIONS_TABLE = "__drizzle_migrations";

export type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

export type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

export function readJournal(folder = MIGRATIONS_FOLDER): Journal {
  return JSON.parse(
    readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"),
  ) as Journal;
}

export function readMigrationSql(tag: string, folder = MIGRATIONS_FOLDER): string {
  return readFileSync(path.join(folder, `${tag}.sql`), "utf8");
}

/** sha256 hex of the migration file text, exactly as the migrator computes it. */
export function migrationHash(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

/** The first journal entry, with the hash and created_at the migrator would record. */
export function baselineRecord(folder = MIGRATIONS_FOLDER): {
  tag: string;
  hash: string;
  createdAt: number;
} {
  const first = readJournal(folder).entries[0];
  if (!first) {
    throw new Error("drizzle/meta/_journal.json has no entries");
  }
  return {
    tag: first.tag,
    hash: migrationHash(readMigrationSql(first.tag, folder)),
    createdAt: first.when,
  };
}

// ---------------------------------------------------------------------------
// Drift check: drizzle-kit snapshot vs live catalog shape
// ---------------------------------------------------------------------------

type SnapshotColumn = {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: unknown;
};

type SnapshotTable = {
  name: string;
  schema: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, { name: string; isUnique: boolean }>;
  foreignKeys: Record<string, { name: string }>;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  uniqueConstraints: Record<string, { name: string }>;
  checkConstraints: Record<string, { name: string }>;
};

export type PgSnapshot = {
  tables: Record<string, SnapshotTable>;
  enums: Record<string, { name: string; schema: string; values: string[] }>;
};

export function readSnapshot(tag: string, folder = MIGRATIONS_FOLDER): PgSnapshot {
  const idx = tag.split("_")[0];
  return JSON.parse(
    readFileSync(path.join(folder, "meta", `${idx}_snapshot.json`), "utf8"),
  ) as PgSnapshot;
}

/** Shape read from pg_catalog for schema `public` (see scripts/db-baseline.ts). */
export type LiveSchema = {
  columns: {
    table: string;
    column: string;
    type: string;
    notNull: boolean;
    hasDefault: boolean;
  }[];
  primaryKeys: { table: string; column: string }[];
  /** Unique, foreign key and check constraints (primary keys are compared per column). */
  constraints: { table: string; name: string; kind: "u" | "f" | "c" }[];
  /** Indexes not backing a constraint. */
  indexes: { table: string; name: string; isUnique: boolean }[];
  enums: { name: string; values: string[] }[];
};

/**
 * Normalizes a one-dimensional text array from a driver row: a JS array, a
 * JSON array string, or a Postgres array literal such as `{a,"b c","d\"e"}`
 * (Neon HTTP leaves arrays of unregistered types like name[] as literals).
 */
export function pgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") {
    throw new Error(`Expected an array, got ${typeof value}`);
  }
  const text = value.trim();
  if (text.startsWith("[")) return (JSON.parse(text) as unknown[]).map(String);
  if (!text.startsWith("{") || !text.endsWith("}")) {
    throw new Error(`Not a Postgres array literal: ${text}`);
  }
  const body = text.slice(1, -1);
  const out: string[] = [];
  if (body.length === 0) return out;
  let i = 0;
  while (i <= body.length) {
    let item = "";
    if (body[i] === '"') {
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i++;
        item += body[i];
        i++;
      }
      i++; // closing quote
    } else {
      while (i < body.length && body[i] !== ",") {
        item += body[i];
        i++;
      }
      item = item.trim();
    }
    out.push(item);
    i++; // comma
  }
  return out;
}

function diffSets(label: string, expected: Set<string>, actual: Set<string>): string[] {
  const out: string[] = [];
  for (const key of expected) if (!actual.has(key)) out.push(`missing ${label} ${key}`);
  for (const key of actual) if (!expected.has(key)) out.push(`unexpected ${label} ${key}`);
  return out;
}

/**
 * Compares tables, columns (type, not null, default present, primary key),
 * enums (ordered values), index names and uniqueness, and unique, foreign key
 * and check constraint names. Expressions (defaults, checks, index predicates)
 * are not compared. Returns one line per difference; empty means no drift.
 */
export function schemaDrift(snapshot: PgSnapshot, live: LiveSchema): string[] {
  const drift: string[] = [];
  const tables = Object.values(snapshot.tables).filter(
    (t) => t.schema === "" || t.schema === "public",
  );

  drift.push(
    ...diffSets(
      "table",
      new Set(tables.map((t) => t.name)),
      new Set(live.columns.map((c) => c.table)),
    ),
  );

  const expectedCols = new Set<string>();
  const expectedPk = new Set<string>();
  const expectedCons = new Set<string>();
  const expectedIdx = new Set<string>();
  for (const t of tables) {
    for (const c of Object.values(t.columns)) {
      expectedCols.add(
        `${t.name}.${c.name} ${c.type} notNull=${c.notNull} default=${c.default !== undefined}`,
      );
      if (c.primaryKey) expectedPk.add(`${t.name}.${c.name}`);
    }
    for (const pk of Object.values(t.compositePrimaryKeys)) {
      for (const col of pk.columns) expectedPk.add(`${t.name}.${col}`);
    }
    for (const u of Object.values(t.uniqueConstraints)) expectedCons.add(`${t.name}.${u.name} u`);
    for (const f of Object.values(t.foreignKeys)) expectedCons.add(`${t.name}.${f.name} f`);
    for (const c of Object.values(t.checkConstraints)) expectedCons.add(`${t.name}.${c.name} c`);
    for (const i of Object.values(t.indexes)) {
      expectedIdx.add(`${t.name}.${i.name} unique=${i.isUnique}`);
    }
  }

  drift.push(
    ...diffSets(
      "column",
      expectedCols,
      new Set(
        live.columns.map(
          (c) => `${c.table}.${c.column} ${c.type} notNull=${c.notNull} default=${c.hasDefault}`,
        ),
      ),
    ),
    ...diffSets(
      "primary key column",
      expectedPk,
      new Set(live.primaryKeys.map((p) => `${p.table}.${p.column}`)),
    ),
    ...diffSets(
      "constraint",
      expectedCons,
      new Set(live.constraints.map((c) => `${c.table}.${c.name} ${c.kind}`)),
    ),
    ...diffSets(
      "index",
      expectedIdx,
      new Set(live.indexes.map((i) => `${i.table}.${i.name} unique=${i.isUnique}`)),
    ),
    ...diffSets(
      "enum",
      new Set(
        Object.values(snapshot.enums)
          .filter((e) => e.schema === "public")
          .map((e) => `${e.name}(${e.values.join(",")})`),
      ),
      new Set(live.enums.map((e) => `${e.name}(${e.values.join(",")})`)),
    ),
  );

  return drift;
}
