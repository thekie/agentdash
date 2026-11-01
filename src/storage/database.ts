import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { z } from "zod";

const schema = `
CREATE TABLE dashboards (
  id TEXT PRIMARY KEY,
  parentId TEXT REFERENCES dashboards(id),
  ord INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  icon TEXT,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT
) STRICT;
CREATE UNIQUE INDEX dashboardsLiveSlug ON dashboards(coalesce(parentId, ''), slug)
  WHERE archivedAt IS NULL;

CREATE TABLE widgets (
  id TEXT PRIMARY KEY,
  dashboardId TEXT REFERENCES dashboards(id),
  parentId TEXT REFERENCES widgets(id),
  ord INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  config TEXT NOT NULL,
  projection TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT,
  CHECK ((dashboardId IS NULL) <> (parentId IS NULL))
) STRICT;

CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  columns TEXT NOT NULL,
  key TEXT NOT NULL,
  nextColumn INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archivedAt TEXT
) STRICT;
CREATE UNIQUE INDEX storesLiveName ON stores(name) WHERE archivedAt IS NULL;
`;

/** Each entry upgrades the database by one `user_version`. Append, never edit. */
const migrations = [schema];

export interface Database {
  /** Runs a statement and returns the rows parsed by `row`. */
  all<T extends z.ZodType>(row: T, sql: string, ...params: SQLInputValue[]): z.output<T>[];
  /** Runs a statement and returns the first row parsed by `row`, if any. */
  one<T extends z.ZodType>(
    row: T,
    sql: string,
    ...params: SQLInputValue[]
  ): z.output<T> | undefined;
  run(sql: string, ...params: SQLInputValue[]): void;
  exec(sql: string): void;
  /** Runs `body` atomically: everything it wrote is rolled back if it throws. */
  transaction<T>(body: () => T): T;
  /** Runs `body` and then rolls back everything it wrote, returning what it returned. */
  rehearse<T>(body: () => T): T;
  close(): void;
}

/** Opens or creates the SQLite file at `path` (or `:memory:`) and brings its schema up to date. */
export function openDatabase(path: string): Database {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode = WAL");
  const database: Database = {
    all: (row, sql, ...params) =>
      sqlite
        .prepare(sql)
        .all(...params)
        .map((r) => row.parse({ ...r })),
    one: (row, sql, ...params) => {
      const found = sqlite.prepare(sql).get(...params);
      return found === undefined ? undefined : row.parse({ ...found });
    },
    run: (sql, ...params) => void sqlite.prepare(sql).run(...params),
    exec: (sql) => sqlite.exec(sql),
    transaction: (body) => {
      sqlite.exec("SAVEPOINT tx");
      try {
        const result = body();
        sqlite.exec("RELEASE tx");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK TO tx");
        sqlite.exec("RELEASE tx");
        throw error;
      }
    },
    rehearse: (body) => {
      sqlite.exec("SAVEPOINT rehearsal");
      try {
        return body();
      } finally {
        sqlite.exec("ROLLBACK TO rehearsal");
        sqlite.exec("RELEASE rehearsal");
      }
    },
    close: () => sqlite.close(),
  };
  migrate(sqlite);
  return database;
}

function migrate(sqlite: DatabaseSync): void {
  const version = Number(sqlite.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  for (const [index, migration] of migrations.entries()) {
    if (index < version) continue;
    sqlite.exec(`BEGIN; ${migration}; PRAGMA user_version = ${index + 1}; COMMIT;`);
  }
}

/** A new stable id such as `d_k3v9x2m7q1`. Lowercase letters and digits only, so it is safe in SQL identifiers. */
export function createId(prefix: "d" | "w" | "s"): string {
  return `${prefix}_${randomBytes(8).readBigUInt64BE().toString(36).padStart(13, "0").slice(0, 13)}`;
}

/** Quotes an identifier for SQL. Identifiers come only from ids and physical column names. */
export function quoteId(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
