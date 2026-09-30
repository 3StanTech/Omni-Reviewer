import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

import {
  baselineRecord,
  MIGRATIONS_FOLDER,
  migrationHash,
  pgTextArray,
  readJournal,
  readMigrationSql,
  readSnapshot,
  schemaDrift,
  type LiveSchema,
} from "../scripts/migration-hash";

const schemaSource = readFileSync(
  path.resolve(__dirname, "..", "lib", "schema.ts"),
  "utf8",
);

describe("committed migrations", () => {
  const journal = readJournal();

  it("lists the baseline first", () => {
    expect(journal.entries[0]?.tag).toBe("0000_baseline");
    expect(journal.entries[0]?.idx).toBe(0);
  });

  it("some committed migration creates every pgTable in lib/schema.ts", () => {
    const tables = [...schemaSource.matchAll(/pgTable\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(tables.length).toBeGreaterThan(0);
    const all = journal.entries.map((entry) => readMigrationSql(entry.tag)).join("\n");
    for (const table of tables) {
      expect(all).toContain(`CREATE TABLE "${table}"`);
    }
    expect(readMigrationSql("0000_baseline")).toContain('CREATE TABLE "users"');
  });

  it("lists 0002_tutor after 0001_fsrs", () => {
    expect(journal.entries.map((entry) => entry.tag).slice(0, 3)).toEqual([
      "0000_baseline",
      "0001_fsrs",
      "0002_tutor",
    ]);
  });

  it("0002_tutor only adds a type, a table, columns, constraints and indexes", () => {
    const statements = readMigrationSql("0002_tutor")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    const addOnly = [
      /^CREATE TYPE "public"\."chat_role" AS ENUM\('user', 'assistant'\);$/,
      /^CREATE TABLE "pack_chat_messages" \(/,
      /^ALTER TABLE "(cards|sources|views)" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS \(.+\) STORED;$/,
      /^ALTER TABLE "pack_chat_messages" ADD CONSTRAINT "[a-z_]+" FOREIGN KEY /,
      /^CREATE INDEX "[a-z_]+" ON "(pack_chat_messages|cards|sources|views)" USING (btree|gin) /,
    ];
    for (const statement of statements) {
      expect(
        addOnly.some((pattern) => pattern.test(statement)),
        statement,
      ).toBe(true);
      expect(statement).not.toMatch(/(?<!ON )\b(DROP|RENAME|ALTER COLUMN|TRUNCATE|DELETE|UPDATE)\b/i);
    }
  });

  it("0002_tutor defines the chat table, the content check and bounded search vectors", () => {
    const text = readMigrationSql("0002_tutor");
    expect(text).toContain("CHECK (char_length(\"pack_chat_messages\".\"content\") <= 20000)");
    expect(text).toContain(
      "to_tsvector('english', left(coalesce(extracted_text, ''), 150000))",
    );
    expect(text).toContain("to_tsvector('english', left(content, 150000))");
    expect(text).toContain("to_tsvector('english', front || ' ' || back)");
    for (const table of ["cards", "sources", "views"]) {
      expect(text).toContain(
        `CREATE INDEX "${table}_search_tsv_idx" ON "${table}" USING gin ("search_tsv")`,
      );
    }
    expect(text).toMatch(/"reply_to_id"\) REFERENCES "public"\."pack_chat_messages"\("id"\) ON DELETE set null/);
    expect(text).toContain('WHERE "pack_chat_messages"."origin_key" IS NOT NULL');
    expect(text).toContain('WHERE "pack_chat_messages"."saved_at" IS NOT NULL');
  });

  it("the latest snapshot records the generated search columns", () => {
    const latest = readSnapshot("0002_tutor") as unknown as {
      tables: Record<string, { columns: Record<string, { type: string; generated?: { type: string } }> }>;
    };
    for (const table of ["cards", "sources", "views"]) {
      const column = latest.tables[`public.${table}`]?.columns.search_tsv;
      expect(column?.type, table).toBe("tsvector");
      expect(column?.generated?.type, table).toBe("stored");
    }
    expect(latest.tables["public.pack_chat_messages"]).toBeDefined();
  });

  it("no migration drops a table or column", () => {
    const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBe(journal.entries.length);
    for (const file of files) {
      const text = readFileSync(path.join(MIGRATIONS_FOLDER, file), "utf8");
      expect(text, file).not.toMatch(/DROP\s+TABLE/i);
      expect(text, file).not.toMatch(/DROP\s+COLUMN/i);
    }
  });

  it("hash and created_at match what drizzle's migrator records", () => {
    const fromMigrator = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
    expect(fromMigrator).toHaveLength(journal.entries.length);
    journal.entries.forEach((entry, i) => {
      expect(migrationHash(readMigrationSql(entry.tag))).toBe(fromMigrator[i].hash);
      expect(entry.when).toBe(fromMigrator[i].folderMillis);
    });
    const baseline = baselineRecord();
    expect(baseline.hash).toBe(fromMigrator[0].hash);
    expect(baseline.createdAt).toBe(fromMigrator[0].folderMillis);
  });
});

describe("schemaDrift", () => {
  const snapshot = readSnapshot("0000_baseline");

  /** Live shape that exactly matches the snapshot. */
  function liveFromSnapshot(): LiveSchema {
    const live: LiveSchema = {
      columns: [],
      primaryKeys: [],
      constraints: [],
      indexes: [],
      enums: [],
    };
    for (const t of Object.values(snapshot.tables)) {
      for (const c of Object.values(t.columns)) {
        live.columns.push({
          table: t.name,
          column: c.name,
          type: c.type,
          notNull: c.notNull,
          hasDefault: c.default !== undefined,
        });
        if (c.primaryKey) live.primaryKeys.push({ table: t.name, column: c.name });
      }
      for (const u of Object.values(t.uniqueConstraints)) {
        live.constraints.push({ table: t.name, name: u.name, kind: "u" });
      }
      for (const f of Object.values(t.foreignKeys)) {
        live.constraints.push({ table: t.name, name: f.name, kind: "f" });
      }
      for (const c of Object.values(t.checkConstraints)) {
        live.constraints.push({ table: t.name, name: c.name, kind: "c" });
      }
      for (const i of Object.values(t.indexes)) {
        live.indexes.push({ table: t.name, name: i.name, isUnique: i.isUnique });
      }
    }
    for (const e of Object.values(snapshot.enums)) {
      live.enums.push({ name: e.name, values: [...e.values] });
    }
    return live;
  }

  it("reports nothing when the database matches the baseline", () => {
    expect(schemaDrift(snapshot, liveFromSnapshot())).toEqual([]);
  });

  it("reports a missing column, a nullability change and an extra index", () => {
    const live = liveFromSnapshot();
    live.columns = live.columns.filter(
      (c) => !(c.table === "cards" && c.column === "front"),
    );
    const back = live.columns.find((c) => c.table === "cards" && c.column === "back");
    back!.notNull = false;
    live.indexes.push({ table: "cards", name: "cards_extra_idx", isUnique: false });

    const drift = schemaDrift(snapshot, live);
    expect(drift).toContain("missing column cards.front text notNull=true default=false");
    expect(drift).toContain("unexpected column cards.back text notNull=false default=false");
    expect(drift).toContain("unexpected index cards.cards_extra_idx unique=false");
  });

  it("accepts enum values as a JS array, JSON text or a Postgres array literal", () => {
    expect(pgTextArray(["again", "good"])).toEqual(["again", "good"]);
    expect(pgTextArray('["again","good"]')).toEqual(["again", "good"]);
    expect(pgTextArray("{again,good}")).toEqual(["again", "good"]);
    expect(pgTextArray('{plain,"with space","a,b","q\\"x",""}')).toEqual([
      "plain",
      "with space",
      "a,b",
      'q"x',
      "",
    ]);
    expect(pgTextArray("{}")).toEqual([]);
    expect(() => pgTextArray(3)).toThrow();

    const live = liveFromSnapshot();
    live.enums = live.enums.map((e) => ({
      name: e.name,
      values: pgTextArray(`{${e.values.join(",")}}`),
    }));
    expect(schemaDrift(snapshot, live)).toEqual([]);
  });

  it("reports reordered enum values", () => {
    const live = liveFromSnapshot();
    const rating = live.enums.find((e) => e.name === "card_rating");
    rating!.values.reverse();
    expect(schemaDrift(snapshot, live)).toContain("unexpected enum card_rating(good,again)");
  });
});
