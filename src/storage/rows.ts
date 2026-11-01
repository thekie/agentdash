import { z } from "zod";
import type { Column } from "./columns.ts";
import { type Database, quoteId } from "./database.ts";
import { assertNoIssues, assertVersion, type Issue, type Path, StorageError } from "./errors.ts";
import { assertStoreLive, findStore, liveColumns, type StoreRow, tableOf } from "./stores.ts";
import { formatValue, parseValue, type StoredValue } from "./values.ts";

/** The most rows one append or update may carry. */
const MAX_BATCH = 1000;

const RowRecord = z
  .object({
    id: z.number(),
    version: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    archivedAt: z.string().nullable(),
  })
  .catchall(z.union([z.string(), z.number(), z.null()]));
type RowRecord = z.infer<typeof RowRecord>;

export interface Row {
  id: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Live columns by key, in the Agent's value forms. */
  values: Record<string, unknown>;
}

function toRow(store: StoreRow, record: RowRecord): Row {
  const { id, version, createdAt, updatedAt, archivedAt } = record;
  const values = Object.fromEntries(
    liveColumns(store).map((c) => [c.key, formatValue(c, record[c.physical] ?? null)]),
  );
  return { id, version, createdAt, updatedAt, archivedAt, values };
}

/** Physical column name to stored value. */
type StoredValues = Map<string, StoredValue>;

function parseValues(
  columns: Column[],
  values: Record<string, unknown>,
  path: Path,
  issues: Issue[],
): StoredValues {
  const stored: StoredValues = new Map();
  for (const [key, value] of Object.entries(values)) {
    const column = columns.find((c) => c.key === key);
    if (!column) {
      issues.push({
        path: [...path, key],
        problem: "unknown column",
        validValues: columns.map((c) => c.key),
      });
      continue;
    }
    const parsed = parseValue(column, value);
    if (parsed.ok) stored.set(column.physical, parsed.stored);
    else issues.push({ path: [...path, key], problem: "wrong type", ...parsed });
  }
  return stored;
}

function assertBatchSize(count: number): void {
  if (count > MAX_BATCH) {
    throw new StorageError("invalid", `At most ${MAX_BATCH} rows per call, got ${count}`, {
      issues: [{ path: ["rows"], problem: "too many rows" }],
    });
  }
}

function findByKey(
  db: Database,
  store: StoreRow,
  values: StoredValues,
  except?: number,
): RowRecord | undefined {
  if (store.key.length === 0) return undefined;
  const where = store.key.map((p) => `${quoteId(p)} IS ?`).join(" AND ");
  return db.one(
    RowRecord,
    `SELECT * FROM ${tableOf(store)} WHERE archivedAt IS NULL AND id IS NOT ? AND ${where}`,
    except ?? null,
    ...store.key.map((p) => values.get(p) ?? null),
  );
}

function insertRow(db: Database, store: StoreRow, values: StoredValues, now: string): number {
  const names = [...values.keys()].map((p) => `, ${quoteId(p)}`).join("");
  const marks = [...values.keys()].map(() => ", ?").join("");
  const record = db.one(
    z.object({ id: z.number() }),
    `INSERT INTO ${tableOf(store)} (version, createdAt, updatedAt${names}) VALUES (1, ?, ?${marks}) RETURNING id`,
    now,
    now,
    ...values.values(),
  );
  return record?.id ?? 0;
}

function writeValues(
  db: Database,
  store: StoreRow,
  id: number,
  values: StoredValues,
  now: string,
): void {
  const sets = [...values.keys()].map((p) => `, ${quoteId(p)} = ?`).join("");
  db.run(
    `UPDATE ${tableOf(store)} SET version = version + 1, updatedAt = ?${sets} WHERE id = ?`,
    now,
    ...values.values(),
    id,
  );
}

function rowRecord(db: Database, store: StoreRow, id: number): RowRecord | undefined {
  return db.one(RowRecord, `SELECT * FROM ${tableOf(store)} WHERE id = ?`, id);
}

function writableStore(db: Database, ref: string): StoreRow {
  const store = findStore(db, ref);
  assertStoreLive(store);
  return store;
}

/** What to do with an appended row whose Key matches a live row. */
export type OnConflict = "error" | "update" | "skip";

export interface AppendRowsInput {
  store: string;
  rows: Record<string, unknown>[];
  onConflict?: OnConflict | undefined;
}

export interface AppendResult {
  inserted: number[];
  updated: number[];
  skipped: number[];
}

/**
 * Appends rows; run it inside a transaction so a failure writes none. A row whose Key matches a live row follows `onConflict`: `error`
 * (the default) fails with `conflict` listing the matching rows, `update` overwrites the given
 * values, `skip` leaves the row as it is. Fails with `invalid` listing every bad value.
 */
export function appendRows(db: Database, input: AppendRowsInput, now: string): AppendResult {
  assertBatchSize(input.rows.length);
  const store = writableStore(db, input.store);
  const issues: Issue[] = [];
  const parsed = input.rows.map((row, index) =>
    parseValues(liveColumns(store), row, ["rows", index], issues),
  );
  assertNoIssues(issues, "Some rows do not fit the Data Store's columns");
  const result: AppendResult = { inserted: [], updated: [], skipped: [] };
  const conflicts: KeyConflict[] = [];
  const insertedBy = new Map<number, number>();
  for (const [index, values] of parsed.entries()) {
    const outcome = appendOne(db, store, values, input.onConflict ?? "error", now);
    if ("match" in outcome) conflicts.push(keyConflict(index, outcome.match, insertedBy));
    else result[outcome.list].push(outcome.id);
    if ("list" in outcome && outcome.list === "inserted") insertedBy.set(outcome.id, index);
  }
  if (conflicts.length > 0) {
    throw new StorageError("conflict", `${conflicts.length} rows share a Key with another row`, {
      current: conflicts,
      hint: 'Pass onConflict "update" to overwrite existing rows or "skip" to keep them.',
    });
  }
  return result;
}

/** An appended row whose Key matches a stored row, or an earlier row of the same batch. */
export type KeyConflict = { index: number; row: Row } | { index: number; sameKeyAsIndex: number };

function keyConflict(index: number, match: Row, insertedBy: Map<number, number>): KeyConflict {
  const earlier = insertedBy.get(match.id);
  return earlier === undefined ? { index, row: match } : { index, sameKeyAsIndex: earlier };
}

type AppendOutcome = { list: keyof AppendResult; id: number } | { match: Row };

function appendOne(
  db: Database,
  store: StoreRow,
  values: StoredValues,
  onConflict: OnConflict,
  now: string,
): AppendOutcome {
  const match = findByKey(db, store, values);
  if (!match) return { list: "inserted", id: insertRow(db, store, values, now) };
  if (onConflict === "skip") return { list: "skipped", id: match.id };
  if (onConflict === "error") return { match: toRow(store, match) };
  writeValues(db, store, match.id, values, now);
  return { list: "updated", id: match.id };
}

function assertKeyFree(db: Database, store: StoreRow, record: RowRecord, path: Path): void {
  const values: StoredValues = new Map(store.key.map((p) => [p, record[p] ?? null]));
  const other = findByKey(db, store, values, record.id);
  if (other) {
    throw new StorageError(
      "conflict",
      `Row ${record.id} would share its Key with row ${other.id}`,
      {
        current: toRow(store, other),
        issues: [{ path, problem: "duplicate Key" }],
      },
    );
  }
}

function rowAtVersion(
  db: Database,
  store: StoreRow,
  id: number,
  expectedVersion: number,
): RowRecord {
  const record = rowRecord(db, store, id);
  if (!record) throw new StorageError("not_found", `No row ${id} in Data Store "${store.name}"`);
  assertVersion(record, expectedVersion, () => toRow(store, record));
  return record;
}

export interface RowUpdate {
  id: number;
  expectedVersion: number;
  /** Only the columns to change. */
  values: Record<string, unknown>;
}

/**
 * Changes the given values of live rows; run it inside a transaction so a failure writes none.
 * Fails with `conflict` on a stale version or a duplicate Key, and `archived` on an Archived row.
 */
export function updateRows(
  db: Database,
  input: { store: string; rows: RowUpdate[] },
  now: string,
): Row[] {
  assertBatchSize(input.rows.length);
  const store = writableStore(db, input.store);
  const issues: Issue[] = [];
  const updates = input.rows.map((update, index) => ({
    ...update,
    stored: parseValues(liveColumns(store), update.values, ["rows", index, "values"], issues),
  }));
  assertNoIssues(issues, "Some values do not fit the Data Store's columns");
  return updates.map((update, index) => {
    const before = rowAtVersion(db, store, update.id, update.expectedVersion);
    if (before.archivedAt !== null) {
      throw new StorageError("archived", `Row ${update.id} is Archived; restore it first`);
    }
    writeValues(db, store, update.id, update.stored, now);
    const record = { ...before, ...Object.fromEntries(update.stored) };
    assertKeyFree(db, store, record, ["rows", index]);
    return toRow(store, { ...record, version: before.version + 1, updatedAt: now });
  });
}

export interface RowRef {
  store: string;
  id: number;
  expectedVersion: number;
}

function setRowArchivedAt(
  db: Database,
  input: RowRef,
  archivedAt: string | null,
  now: string,
): Row {
  const store = writableStore(db, input.store);
  const record = rowAtVersion(db, store, input.id, input.expectedVersion);
  if ((record.archivedAt === null) === (archivedAt === null)) return toRow(store, record);
  if (archivedAt === null) assertKeyFree(db, store, record, ["id"]);
  db.run(
    `UPDATE ${tableOf(store)} SET archivedAt = ?, version = version + 1, updatedAt = ? WHERE id = ?`,
    archivedAt,
    now,
    input.id,
  );
  return toRow(store, { ...record, archivedAt, version: record.version + 1, updatedAt: now });
}

/** Archives a row. Archiving it again changes nothing. */
export function archiveRow(db: Database, input: RowRef, now: string): Row {
  return setRowArchivedAt(db, input, now, now);
}

/** Restores an Archived row. Fails with `conflict` when a live row took its Key. */
export function restoreRow(db: Database, input: RowRef, now: string): Row {
  return setRowArchivedAt(db, input, null, now);
}

function rowsWhere(db: Database, ref: string, archivedAt: "IS NULL" | "IS NOT NULL"): Row[] {
  const store = findStore(db, ref);
  return db
    .all(RowRecord, `SELECT * FROM ${tableOf(store)} WHERE archivedAt ${archivedAt} ORDER BY id`)
    .map((record) => toRow(store, record));
}

/** The live rows of a Data Store, by id or name, in insertion order. */
export function liveRows(db: Database, ref: string): Row[] {
  return rowsWhere(db, ref, "IS NULL");
}

/** The Archived rows of a Data Store, by id or name, in insertion order. */
export function archivedRows(db: Database, ref: string): Row[] {
  return rowsWhere(db, ref, "IS NOT NULL");
}
