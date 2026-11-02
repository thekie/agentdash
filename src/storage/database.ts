import { randomBytes } from "node:crypto";
import { constants, DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import type { z } from "zod";

const schema = `
CREATE TABLE dashboards (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 15 AND substr(id, 1, 2) = 'd_' AND substr(id, 3) NOT GLOB '*[^0-9a-z]*'),
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
  id TEXT PRIMARY KEY
    CHECK (length(id) = 15 AND substr(id, 1, 2) = 'w_' AND substr(id, 3) NOT GLOB '*[^0-9a-z]*'),
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
  id TEXT PRIMARY KEY
    CHECK (length(id) = 15 AND substr(id, 1, 2) = 's_' AND substr(id, 3) NOT GLOB '*[^0-9a-z]*'),
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

/**
 * The schema changes in order. Each entry upgrades a database by one `user_version`. A database
 * never runs an entry twice, so a schema change needs a new entry at the end.
 */
export const migrations = [schema];

/** Describes a connection to the SQLite database. */
export interface Database {
  /** Returns every row of the statement, parsed by `row`. */
  all<T extends z.ZodType>(row: T, sql: string, ...params: SQLInputValue[]): z.output<T>[];
  /** Returns the first row of the statement parsed by `row`, or `undefined` if there is none. */
  one<T extends z.ZodType>(
    row: T,
    sql: string,
    ...params: SQLInputValue[]
  ): z.output<T> | undefined;
  run(sql: string, ...params: SQLInputValue[]): void;
  /**
   * Returns every row of a statement that only reads Data Store tables. Throws if the statement
   * writes, reads another table, or calls a function other than `count`, `sum`, `avg`, `min`,
   * `max`, `last_value`, `date`, `strftime` and `printf`.
   */
  select(sql: string, ...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
  exec(sql: string): void;
  /** Runs `body` atomically. If `body` throws, everything that it wrote is rolled back. */
  transaction<T>(body: () => T): T;
  /** Runs `body`, rolls back everything that it wrote, and returns the result of `body`. */
  rehearse<T>(body: () => T): T;
  close(): void;
}

/** The functions that a statement passed to `select` can call. */
const readFunctions = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "last_value",
  "date",
  "strftime",
  "printf",
]);

/**
 * Returns `SQLITE_OK` for a read of a Data Store table or a call of a function in `readFunctions`,
 * and `SQLITE_DENY` for anything else.
 */
function readOnly(action: number, table: string | null, nameOrColumn: string | null) {
  const allowed =
    action === constants.SQLITE_SELECT ||
    (action === constants.SQLITE_READ && table?.startsWith("ds_") === true) ||
    (action === constants.SQLITE_FUNCTION && readFunctions.has(nameOrColumn ?? ""));
  return allowed ? constants.SQLITE_OK : constants.SQLITE_DENY;
}

/**
 * Opens the SQLite file at `path`, or creates it, and runs the migrations that it has not run. The
 * path `:memory:` opens a database that is not stored.
 */
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
    select: (sql, ...params) => {
      sqlite.setAuthorizer(readOnly);
      try {
        return sqlite
          .prepare(sql)
          .all(...params)
          .map((r) => ({ ...r }));
      } finally {
        sqlite.setAuthorizer(null);
      }
    },
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
  migrate(sqlite, migrations);
  return database;
}

/**
 * Runs each entry of `entries` that the database has not run, in its own transaction. If an entry
 * fails, it rolls that entry back and throws the SQLite error.
 */
export function migrate(sqlite: DatabaseSync, entries: string[]): void {
  const version = Number(sqlite.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  for (const [index, entry] of entries.entries()) {
    if (index < version) continue;
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(`${entry}; PRAGMA user_version = ${index + 1}`);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Returns a new id with the given prefix, for example `d_0k3v9x2m7q1ab`. The id holds only
 * lowercase letters, digits and `_`.
 */
export function createId(prefix: "d" | "w" | "s"): string {
  return `${prefix}_${randomBytes(8).readBigUInt64BE().toString(36).padStart(13, "0").slice(0, 13)}`;
}

/** Returns `name` quoted as an SQL identifier. */
export function quoteId(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
