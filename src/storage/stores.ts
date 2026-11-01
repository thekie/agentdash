import { z } from "zod";
import {
  Column,
  ColumnKey,
  ColumnSpec,
  ColumnTypeSpec,
  EnumOptionSpec,
  storedType,
} from "./columns.ts";
import { createId, type Database, quoteId } from "./database.ts";
import { assertNoIssues, type Issue, StorageError } from "./errors.ts";
import { formatValue, retypeValue, sqlTypeOf } from "./values.ts";

const StoreRow = z.object({
  id: z.string(),
  name: z.string(),
  columns: z.string().transform((s) => z.array(Column).parse(JSON.parse(s))),
  key: z.string().transform((s) => z.array(z.string()).parse(JSON.parse(s))),
  nextColumn: z.number(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type StoreRow = z.infer<typeof StoreRow>;

export interface DataStore {
  id: string;
  name: string;
  /** Live columns in order. */
  columns: Column[];
  archivedColumns: Column[];
  /** Keys of the Key columns; empty when the Data Store has no Key. */
  key: string[];
  rowCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** The SQL table holding a Data Store's rows. */
export function tableOf(store: { id: string }): string {
  return quoteId(`ds_${store.id}`);
}

export function liveColumns(store: StoreRow): Column[] {
  return store.columns.filter((c) => c.archivedAt === undefined);
}

function readStore(db: Database, ref: string): StoreRow | undefined {
  return (
    db.one(StoreRow, "SELECT * FROM stores WHERE id = ?", ref) ??
    db.one(StoreRow, "SELECT * FROM stores WHERE name = ? AND archivedAt IS NULL", ref)
  );
}

/** Finds a Data Store by id or live name. Fails with `not_found`. */
export function findStore(db: Database, ref: string): StoreRow {
  const store = readStore(db, ref);
  if (!store) throw new StorageError("not_found", `No Data Store with id or name "${ref}"`);
  return store;
}

/** Fails with `archived` when the Data Store is Archived. */
export function failIfArchived(store: StoreRow): void {
  if (store.archivedAt !== null) {
    throw new StorageError(
      "archived",
      `Data Store ${store.id} ("${store.name}") is Archived; restore it first`,
    );
  }
}

export function toDataStore(db: Database, store: StoreRow): DataStore {
  const count = db.one(
    z.object({ n: z.number() }),
    `SELECT count(*) AS n FROM ${tableOf(store)} WHERE archivedAt IS NULL`,
  );
  const byPhysical = new Map(store.columns.map((c) => [c.physical, c.key]));
  return {
    id: store.id,
    name: store.name,
    columns: liveColumns(store),
    archivedColumns: store.columns.filter((c) => c.archivedAt !== undefined),
    key: store.key.map((physical) => byPhysical.get(physical) ?? physical),
    rowCount: count?.n ?? 0,
    version: store.version,
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
    archivedAt: store.archivedAt,
  };
}

/** Fails with `conflict` when the Data Store's version is not `expectedVersion`, returning it. */
export function checkStoreVersion(db: Database, store: StoreRow, expectedVersion: number): void {
  if (store.version !== expectedVersion) {
    throw new StorageError(
      "conflict",
      `Expected version ${expectedVersion}, found ${store.version}`,
      {
        current: toDataStore(db, store),
        hint: "Merge your change into `current` and retry with its version.",
      },
    );
  }
}

/** Fails with `conflict` when another live Data Store has the name, returning that Data Store. */
function checkName(db: Database, name: string, self?: string): void {
  const taken = db.one(
    StoreRow,
    "SELECT * FROM stores WHERE name = ? AND archivedAt IS NULL",
    name,
  );
  if (taken && taken.id !== self) {
    throw new StorageError("conflict", `A Data Store named "${name}" already exists`, {
      current: toDataStore(db, taken),
    });
  }
}

function duplicateKeyIssues(keys: string[], path: (string | number)[]): Issue[] {
  return keys.flatMap((key, index) =>
    keys.indexOf(key) === index
      ? []
      : [{ path: [...path, index, "key"], problem: `duplicate column key "${key}"` }],
  );
}

/** The physical names of the given live column keys, reporting unknown keys as issues. */
function physicalNames(
  columns: Column[],
  keys: string[],
  path: (string | number)[],
  issues: Issue[],
): string[] {
  return keys.flatMap((key, index) => {
    const column = columns.find((c) => c.key === key);
    if (column) return [column.physical];
    issues.push({
      path: [...path, index],
      problem: `unknown column "${key}"`,
      validValues: columns.map((c) => c.key),
    });
    return [];
  });
}

export interface CreateStoreInput {
  name: string;
  columns: ColumnSpec[];
  /** Column keys that identify a row. */
  key?: string[] | undefined;
}

/** Creates a Data Store. Fails with `conflict` when a live Data Store has the name, returning it. */
export function createStore(db: Database, input: CreateStoreInput, now: string): DataStore {
  checkName(db, input.name);
  const columns = input.columns.map((spec, index) => {
    const { key, label } = ColumnSpec.parse(spec);
    const column = { key, physical: `c_${index + 1}`, ...storedType(spec, now) };
    return label === undefined ? column : { ...column, label };
  });
  const issues = duplicateKeyIssues(
    columns.map((c) => c.key),
    ["columns"],
  );
  const key = physicalNames(columns, input.key ?? [], ["key"], issues);
  assertNoIssues(issues, "The Data Store definition is invalid");
  const id = createId("s");
  db.run(
    `INSERT INTO stores (id, name, columns, key, nextColumn, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    JSON.stringify(columns),
    JSON.stringify(key),
    columns.length + 1,
    now,
    now,
  );
  const physical = columns.map((c) => `, ${quoteId(c.physical)} ${sqlTypeOf(c)}`).join("");
  db.exec(
    `CREATE TABLE ${tableOf({ id })} (id INTEGER PRIMARY KEY, version INTEGER NOT NULL,
     createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, archivedAt TEXT${physical}) STRICT`,
  );
  return getStore(db, id);
}

/** Returns a Data Store by id or live name. */
export function getStore(db: Database, ref: string): DataStore {
  return toDataStore(db, findStore(db, ref));
}

/** Every live Data Store, by name. */
export function listStores(db: Database): DataStore[] {
  return db
    .all(StoreRow, "SELECT * FROM stores WHERE archivedAt IS NULL ORDER BY name")
    .map((store) => toDataStore(db, store));
}

export const AlterOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_column"), column: ColumnSpec }),
  z.object({
    op: z.literal("rename_column"),
    column: ColumnKey,
    to: ColumnKey,
    label: z.string().min(1).optional(),
  }),
  z.object({ op: z.literal("retype_column"), column: ColumnKey, to: ColumnTypeSpec }),
  z.object({ op: z.literal("archive_column"), column: ColumnKey }),
  z.object({ op: z.literal("set_key"), columns: z.array(ColumnKey) }),
  z.object({
    op: z.literal("set_enum_options"),
    column: ColumnKey,
    options: z.array(EnumOptionSpec).min(1),
  }),
]);
export type AlterOp = z.input<typeof AlterOp>;

export interface KeyDuplicate {
  values: Record<string, unknown>;
  rowIds: number[];
}

export interface OpReport {
  op: AlterOp["op"];
  /** Values a retype could not convert. They become empty. Lists at most 20 rows. */
  unconverted?: { count: number; rows: { id: number; value: unknown }[] };
  /** Live rows sharing a Key, which block `set_key` and a retype of a Key column. */
  keyDuplicates?: KeyDuplicate[];
}

/** The Data Store as the ops change it, plus the rows the database holds. */
interface Draft {
  db: Database;
  store: StoreRow;
  now: string;
}

function liveColumn(draft: Draft, key: string, path: (string | number)[]): Column {
  const columns = liveColumns(draft.store);
  const column = columns.find((c) => c.key === key);
  if (column) return column;
  throw new StorageError("invalid", `Unknown column "${key}"`, {
    issues: [{ path, problem: "unknown column", validValues: columns.map((c) => c.key) }],
  });
}

function replaceColumn(draft: Draft, physical: string, next: Column[]): void {
  const index = draft.store.columns.findIndex((c) => c.physical === physical);
  draft.store.columns.splice(index, 1, ...next);
}

function failIfKeyTaken(draft: Draft, key: string, path: (string | number)[]): void {
  if (liveColumns(draft.store).some((c) => c.key === key)) {
    throw new StorageError("invalid", `A column "${key}" already exists`, {
      issues: [{ path, problem: `duplicate column key "${key}"` }],
    });
  }
}

const DuplicateRow = z
  .object({ ids: z.string() })
  .catchall(z.union([z.string(), z.number(), z.null()]));

/** Live rows that share values in the given physical columns. */
export function keyDuplicates(draft: Draft, key: string[]): KeyDuplicate[] {
  if (key.length === 0) return [];
  const columns = key.map((physical) => draft.store.columns.find((c) => c.physical === physical));
  const list = key.map(quoteId).join(", ");
  const groups = draft.db.all(
    DuplicateRow,
    `SELECT group_concat(id) AS ids, ${list} FROM ${tableOf(draft.store)} WHERE archivedAt IS NULL
     GROUP BY ${list} HAVING count(*) > 1`,
  );
  return groups.map((group) => ({
    rowIds: group.ids.split(",").map(Number),
    values: Object.fromEntries(
      columns.flatMap((c) => (c ? [[c.key, formatValue(c, group[c.physical] ?? null)]] : [])),
    ),
  }));
}

function addColumn(draft: Draft, spec: ColumnSpec, path: (string | number)[]): Column {
  const { key, label } = ColumnSpec.parse(spec);
  failIfKeyTaken(draft, key, path);
  const physical = `c_${draft.store.nextColumn++}`;
  const column: Column = {
    key,
    physical,
    ...storedType(spec, draft.now),
    ...(label === undefined ? {} : { label }),
  };
  draft.store.columns.push(column);
  draft.db.exec(
    `ALTER TABLE ${tableOf(draft.store)} ADD COLUMN ${quoteId(physical)} ${sqlTypeOf(column)}`,
  );
  return column;
}

const ValueRow = z.object({ id: z.number(), value: z.union([z.string(), z.number(), z.null()]) });

function retypeColumn(
  draft: Draft,
  key: string,
  to: ColumnTypeSpec,
  path: (string | number)[],
): OpReport {
  const from = liveColumn(draft, key, path);
  const label = from.label === undefined ? {} : { label: from.label };
  const physical = `c_${draft.store.nextColumn++}`;
  const column: Column = { key, physical, ...storedType(to, draft.now, from), ...label };
  replaceColumn(draft, from.physical, [column]);
  draft.store.columns.push({ ...from, archivedAt: draft.now });
  draft.store.key = draft.store.key.map((p) => (p === from.physical ? physical : p));
  const table = tableOf(draft.store);
  draft.db.exec(`ALTER TABLE ${table} ADD COLUMN ${quoteId(physical)} ${sqlTypeOf(column)}`);
  const unconverted: { id: number; value: unknown }[] = [];
  for (const row of draft.db.all(
    ValueRow,
    `SELECT id, ${quoteId(from.physical)} AS value FROM ${table}`,
  )) {
    const value = retypeValue(from, column, row.value);
    if (value === undefined) unconverted.push({ id: row.id, value: formatValue(from, row.value) });
    draft.db.run(
      `UPDATE ${table} SET ${quoteId(physical)} = ? WHERE id = ?`,
      value ?? null,
      row.id,
    );
  }
  const report: OpReport = {
    op: "retype_column",
    unconverted: { count: unconverted.length, rows: unconverted.slice(0, 20) },
  };
  return draft.store.key.includes(physical)
    ? { ...report, keyDuplicates: keyDuplicates(draft, draft.store.key) }
    : report;
}

function archiveColumn(draft: Draft, key: string, path: (string | number)[]): void {
  const column = liveColumn(draft, key, path);
  if (draft.store.key.includes(column.physical)) {
    throw new StorageError("invalid", `Column "${key}" is part of the Key; change the Key first`, {
      issues: [{ path, problem: "column is in the Key" }],
    });
  }
  replaceColumn(draft, column.physical, [{ ...column, archivedAt: draft.now }]);
}

function setKey(draft: Draft, keys: string[], path: (string | number)[]): OpReport {
  const issues: Issue[] = [];
  const key = physicalNames(liveColumns(draft.store), keys, path, issues);
  assertNoIssues(issues, "The Key names unknown columns");
  draft.store.key = key;
  return { op: "set_key", keyDuplicates: keyDuplicates(draft, key) };
}

function setEnumOptions(
  draft: Draft,
  key: string,
  options: EnumOptionSpec[],
  path: (string | number)[],
): void {
  const column = liveColumn(draft, key, path);
  if (column.type !== "enum") {
    throw new StorageError("invalid", `Column "${key}" is ${column.type}, not enum`, {
      issues: [{ path, problem: "not an enum column" }],
    });
  }
  replaceColumn(draft, column.physical, [
    { ...column, ...storedType({ type: "enum", options }, draft.now, column) },
  ]);
}

function applyOp(draft: Draft, op: AlterOp, index: number): OpReport {
  const path = ["ops", index, "column"];
  switch (op.op) {
    case "add_column":
      addColumn(draft, op.column, path);
      return { op: op.op };
    case "rename_column": {
      const column = liveColumn(draft, op.column, path);
      if (op.to !== op.column) failIfKeyTaken(draft, op.to, ["ops", index, "to"]);
      replaceColumn(draft, column.physical, [
        { ...column, key: op.to, ...(op.label === undefined ? {} : { label: op.label }) },
      ]);
      return { op: op.op };
    }
    case "retype_column":
      return retypeColumn(draft, op.column, op.to, path);
    case "archive_column":
      archiveColumn(draft, op.column, path);
      return { op: op.op };
    case "set_key":
      return setKey(draft, op.columns, ["ops", index, "columns"]);
    case "set_enum_options":
      setEnumOptions(draft, op.column, op.options, path);
      return { op: op.op };
  }
}

export interface AlterStoreInput {
  store: string;
  expectedVersion: number;
  ops: AlterOp[];
  /** Report what the ops would do, and change nothing. */
  dryRun?: boolean | undefined;
}

export interface AlterResult {
  store: DataStore;
  reports: OpReport[];
}

function applyOps(db: Database, store: StoreRow, input: AlterStoreInput, now: string): AlterResult {
  const draft: Draft = { db, store: structuredClone(store), now };
  const reports = input.ops.map((op, index) => applyOp(draft, op, index));
  db.run(
    `UPDATE stores SET columns = ?, key = ?, nextColumn = ?, version = version + 1, updatedAt = ? WHERE id = ?`,
    JSON.stringify(draft.store.columns),
    JSON.stringify(draft.store.key),
    draft.store.nextColumn,
    now,
    store.id,
  );
  return { store: getStore(db, store.id), reports };
}

/**
 * Applies schema ops in order, all or none. With `dryRun` it reports what they would do and changes
 * nothing. Fails with `conflict` when the ops leave live rows sharing a Key, listing them.
 */
export function alterStore(db: Database, input: AlterStoreInput, now: string): AlterResult {
  const store = findStore(db, input.store);
  checkStoreVersion(db, store, input.expectedVersion);
  failIfArchived(store);
  if (input.dryRun) return db.rehearse(() => applyOps(db, store, input, now));
  return db.transaction(() => {
    const result = applyOps(db, store, input, now);
    const duplicates = result.reports.flatMap((r) => r.keyDuplicates ?? []);
    if (duplicates.length > 0) {
      throw new StorageError("conflict", "Live rows would share a Key", {
        current: duplicates,
        hint: "Archive or update the duplicate rows, or choose another Key. A dryRun shows them without changing anything.",
      });
    }
    return result;
  });
}

/** Archives a Data Store. Its Widgets show an "archived data" placeholder. Archiving it again changes nothing. */
export function archiveStore(
  db: Database,
  input: { id: string; expectedVersion: number },
  now: string,
): DataStore {
  return setStoreArchivedAt(db, input, now, now);
}

/** Restores an Archived Data Store. Fails with `conflict` when a live Data Store took its name. */
export function restoreStore(
  db: Database,
  input: { id: string; expectedVersion: number },
  now: string,
): DataStore {
  return setStoreArchivedAt(db, input, null, now);
}

function setStoreArchivedAt(
  db: Database,
  input: { id: string; expectedVersion: number },
  archivedAt: string | null,
  now: string,
): DataStore {
  const store = findStore(db, input.id);
  checkStoreVersion(db, store, input.expectedVersion);
  if ((store.archivedAt === null) === (archivedAt === null)) return toDataStore(db, store);
  if (archivedAt === null) checkName(db, store.name, store.id);
  db.run(
    "UPDATE stores SET archivedAt = ?, version = version + 1, updatedAt = ? WHERE id = ?",
    archivedAt,
    now,
    store.id,
  );
  return getStore(db, store.id);
}

/** Data Stores that are Archived. */
export function archivedStores(db: Database): DataStore[] {
  return db
    .all(StoreRow, "SELECT * FROM stores WHERE archivedAt IS NOT NULL ORDER BY archivedAt")
    .map((store) => toDataStore(db, store));
}
