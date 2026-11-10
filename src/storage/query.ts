import type { SQLInputValue } from "node:sqlite";
import type { ColumnType } from "./columns.ts";
import { type Database, quoteId } from "./database.ts";
import { type Issue, type Path, StorageError } from "./errors.ts";
import {
  type Bucket,
  isRelative,
  type Output,
  type ProjectionInput,
  type Ref,
  type ResolvedFilter,
  type ResolvedProjection,
  resolveReadableProjection,
} from "./projection.ts";
import { tableOf } from "./stores.ts";
import { formatValue, StoredValue } from "./values.ts";

interface Compiled {
  sql: string;
  params: SQLInputValue[];
}

function columnSql(ref: Ref): string {
  return `${ref.source.alias}.${quoteId(ref.column.physical)}`;
}

const buckets: Record<Bucket, (column: string) => string> = {
  day: (c) => `date(${c})`,
  week: (c) => `date(${c}, '-6 days', 'weekday 1')`,
  month: (c) => `date(${c}, 'start of month')`,
  quarter: (c) =>
    `date(${c}, 'start of month', printf('-%d months', (CAST(strftime('%m', ${c}) AS INTEGER) - 1) % 3))`,
  year: (c) => `date(${c}, 'start of year')`,
};

/** Moves `date` by `months`, and onto the last day of the target month if it is shorter. */
function addMonths(date: Date, months: number): void {
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
}

/** Returns the date or datetime that a relative value such as `-30d` names, counted from `now`. */
function relativeTo(now: string, relative: string, type: ColumnType["type"]): string {
  const [, count = "0", unit = "d"] = /^([+-]?\d+)([dwmy])$/.exec(relative) ?? [];
  const date = new Date(now);
  const n = Number(count);
  if (unit === "d" || unit === "w") date.setUTCDate(date.getUTCDate() + n * (unit === "w" ? 7 : 1));
  if (unit === "m" || unit === "y") addMonths(date, unit === "y" ? 12 * n : n);
  const iso = date.toISOString();
  return type === "date" ? iso.slice(0, 10) : iso;
}

function filterSql(filter: ResolvedFilter, now: string, params: SQLInputValue[]): string {
  const column = columnSql(filter.ref);
  if ("values" in filter) {
    params.push(...filter.values);
    return `${column} IN (${filter.values.map(() => "?").join(", ")})`;
  }
  if (!("value" in filter)) return `${column} ${filter.op === "empty" ? "IS NULL" : "IS NOT NULL"}`;
  const { value } = filter;
  params.push(isRelative(value) ? relativeTo(now, value.relative, filter.ref.column.type) : value);
  return `${column} ${filter.op} ?`;
}

function fromSql(p: ResolvedProjection): string {
  return p.sources
    .map(({ alias, store, join }) => {
      const table = `${tableOf(store)} AS ${alias}`;
      if (!join) return table;
      const kind = join.type === "left" ? "LEFT JOIN" : "JOIN";
      return `${kind} ${table} ON ${columnSql(join.left)} = ${columnSql(join.right)} AND ${alias}.archivedAt IS NULL`;
    })
    .join(" ");
}

/** Returns the WHERE clause that keeps the live rows of `from` that pass the filters. */
export function whereSql(p: ResolvedProjection, now: string, params: SQLInputValue[]): string {
  const filters = p.filters.map((f) => filterSql(f, now, params));
  return ["t0.archivedAt IS NULL", ...filters].join(" AND ");
}

function orderSql(p: ResolvedProjection, fallback: string[]): string {
  const sorts = p.sort.map((s) => `${quoteId(s.name)}${s.desc ? " DESC" : ""}`);
  return [...sorts, ...fallback].join(", ");
}

function groupExpr(output: Output & { kind: "group" }): string {
  const column = columnSql(output.ref);
  return output.bucket ? buckets[output.bucket](column) : column;
}

/** Returns the inner expression of an aggregate, or `undefined` for `count` of every row. */
function aggregateInput(
  output: Output & { kind: "aggregate" },
  partition: string,
): string | undefined {
  if (!output.ref) return undefined;
  const column = columnSql(output.ref);
  if (!output.by) return column;
  const window = `${partition}ORDER BY ${columnSql(output.by)}, t0.id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`;
  return `last_value(${column}) OVER (${window})`;
}

function outerAggregate(output: Output & { kind: "aggregate" }, inner: string): string {
  if (!output.ref) return "count(*)";
  // Every row of a group holds the same `last_value`, so `max` picks it.
  return output.op === "last" ? `max(${inner})` : `${output.op}(${inner})`;
}

function groupedSql(p: ResolvedProjection, now: string, params: SQLInputValue[]): string {
  const groups = p.outputs.filter((o) => o.kind === "group");
  const partition = groups.length > 0 ? `PARTITION BY ${groups.map(groupExpr).join(", ")} ` : "";
  const inner = ["t0.id AS rowId", ...groups.map((g, i) => `${groupExpr(g)} AS g${i}`)];
  const outer = groups.map((g, i) => `g${i} AS ${quoteId(g.name)}`);
  for (const [i, output] of p.outputs.filter((o) => o.kind === "aggregate").entries()) {
    const input = aggregateInput(output, partition);
    if (input) inner.push(`${input} AS a${i}`);
    outer.push(`${outerAggregate(output, `a${i}`)} AS ${quoteId(output.name)}`);
  }
  const groupBy = groups.length > 0 ? ` GROUP BY ${groups.map((_, i) => `g${i}`).join(", ")}` : "";
  const order = orderSql(
    p,
    groups.map((_, i) => `g${i}`),
  );
  return `SELECT ${outer.join(", ")} FROM (SELECT ${inner.join(", ")} FROM ${fromSql(p)} WHERE ${whereSql(p, now, params)})${groupBy}${order ? ` ORDER BY ${order}` : ""} LIMIT ?`;
}

function rawSql(p: ResolvedProjection, now: string, params: SQLInputValue[]): string {
  const columns = p.outputs.flatMap((o) =>
    o.kind === "column" ? [`${columnSql(o.ref)} AS ${quoteId(o.name)}`] : [],
  );
  return `SELECT ${columns.join(", ")} FROM ${fromSql(p)} WHERE ${whereSql(p, now, params)} ORDER BY ${orderSql(p, ["t0.id"])} LIMIT ?`;
}

/**
 * Returns the SQL of a resolved Projection and its parameters. The SQL asks for one row more than
 * the limit, so that a caller can tell whether rows were cut.
 */
export function compileProjection(p: ResolvedProjection, now: string): Compiled {
  const params: SQLInputValue[] = [];
  const sql = p.isGrouped ? groupedSql(p, now, params) : rawSql(p, now, params);
  return { sql, params: [...params, p.limit + 1] };
}

/** Describes the result of a Projection. */
export interface QueryResult {
  /**
   * The output columns. `label` is the header to show: the one the Projection gives, else the Data
   * Store label of a plain or grouped column.
   */
  columns: { name: string; label?: string; type: ColumnType }[];
  /** The rows in the form that Agents read, keyed by output column name. */
  rows: Record<string, unknown>[];
  /** Is true if the Data Stores hold more rows than the limit. */
  truncated: boolean;
}

function resultColumns(p: ResolvedProjection): QueryResult["columns"] {
  return p.outputs.map((o) => {
    const label = o.label ?? (o.kind === "aggregate" ? undefined : o.ref.column.label);
    return { name: o.name, ...(label !== undefined && { label }), type: o.type };
  });
}

/**
 * Returns the output columns of a Projection in readable form, or every problem it has, each with
 * `path` in front.
 */
export function projectionColumns(
  db: Database,
  input: unknown,
  path: Path,
): { columns: QueryResult["columns"] } | { issues: Issue[] } {
  const issues: Issue[] = [];
  const projection = resolveReadableProjection(db, input, path, issues);
  if (!projection) return { issues };
  return { columns: resultColumns(projection) };
}

/**
 * Returns the rows that a Projection in readable form selects, at most its `limit`. Throws
 * `StorageError` `invalid` if the Projection names an unknown Data Store, column or output column.
 */
export function queryProjection(db: Database, input: ProjectionInput, now: string): QueryResult {
  const issues: Issue[] = [];
  const projection = resolveReadableProjection(db, input, [], issues);
  if (!projection) throw new StorageError("invalid", "The Projection is invalid", { issues });
  const { sql, params } = compileProjection(projection, now);
  const rows = db.select(sql, ...params);
  const format = (row: Record<string, unknown>) =>
    Object.fromEntries(
      projection.outputs.map((o) => [o.name, formatValue(o.type, StoredValue.parse(row[o.name]))]),
    );
  return {
    columns: resultColumns(projection),
    rows: rows.slice(0, projection.limit).map(format),
    truncated: rows.length > projection.limit,
  };
}
