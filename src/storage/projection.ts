import { z } from "zod";
import { type Column, ColumnKey, type ColumnType } from "./columns.ts";
import type { Database } from "./database.ts";
import type { Issue, Path } from "./errors.ts";
import { liveColumns, type StoreRow, storeRow } from "./stores.ts";
import { formatValue, parseValue, StoredValue } from "./values.ts";

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

/** The schema of a date relative to today, for example `-30d`. The units are d, w, m and y. */
const RelativeDate = z.strictObject({
  relative: z.string().regex(/^[+-]?\d+[dwmy]$/, "a signed count and a unit, for example -30d"),
});
type RelativeDate = z.infer<typeof RelativeDate>;

/** Reports whether a filter value is a relative date. */
export function isRelative(value: StoredValue | RelativeDate): value is RelativeDate {
  return typeof value === "object" && value !== null;
}

const defaultLimit = 100;
const comparisons = ["=", "!=", "<", "<=", ">", ">="] as const;
const orderedTypes = new Set<ColumnType["type"]>(["text", "number", "money", "date", "datetime"]);

const Filter = z.discriminatedUnion("op", [
  z.strictObject({
    column: z.string(),
    op: z.enum(comparisons),
    value: z.union([Scalar, RelativeDate]),
  }),
  z.strictObject({ column: z.string(), op: z.literal("in"), values: z.array(Scalar).min(1) }),
  z.strictObject({ column: z.string(), op: z.enum(["empty", "notEmpty"]) }),
]);

const Bucket = z.enum(["day", "week", "month", "quarter", "year"]);
/** Describes a time bucket. A week starts on Monday, and every bucket is in UTC. */
export type Bucket = z.infer<typeof Bucket>;

const AggregateOp = z.enum(["count", "sum", "avg", "min", "max", "last"]);
type AggregateOp = z.infer<typeof AggregateOp>;

/**
 * The schema of a Projection. A column is its key in the `from` Data Store, or `store.key` in a
 * joined one. `sort` and `slots` name output columns.
 */
export const Projection = z.strictObject({
  from: z.string().min(1),
  join: z
    .array(
      z.strictObject({
        store: z.string().min(1),
        type: z.enum(["inner", "left"]).default("inner"),
        on: z.strictObject({ left: z.string(), right: z.string() }),
      }),
    )
    .optional(),
  select: z.array(z.strictObject({ column: z.string(), as: ColumnKey.optional() })).optional(),
  filter: z.array(Filter).optional(),
  groupBy: z
    .array(
      z.strictObject({ column: z.string(), bucket: Bucket.optional(), as: ColumnKey.optional() }),
    )
    .optional(),
  aggregate: z
    .array(
      z.strictObject({
        op: AggregateOp,
        column: z.string().optional(),
        by: z.string().optional(),
        as: ColumnKey.optional(),
      }),
    )
    .optional(),
  sort: z.array(z.strictObject({ column: ColumnKey, desc: z.boolean().optional() })).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  slots: z.record(z.string(), z.union([ColumnKey, z.array(ColumnKey).min(1)])).optional(),
});
export type Projection = z.output<typeof Projection>;
/** Describes a Projection as an Agent writes it, before the schema fills in defaults. */
export type ProjectionInput = z.input<typeof Projection>;

/**
 * Describes the two forms of a Projection. The readable form names Data Stores and columns by name
 * and key, with filter values as rows are written. The stored form, which a Widget keeps, uses ids,
 * physical column names and stored values.
 */
export type ProjectionForm = "readable" | "stored";

/** Describes a Data Store that a Projection reads, with the alias of its table in the SQL. */
export interface Source {
  alias: string;
  store: StoreRow;
  join?: { type: "inner" | "left"; left: Ref; right: Ref };
}

/** Describes a column of a Source. */
export interface Ref {
  source: Source;
  column: Column;
}

/** Describes a filter with its value in stored form. */
export type ResolvedFilter =
  | { ref: Ref; op: (typeof comparisons)[number]; value: StoredValue | RelativeDate }
  | { ref: Ref; op: "in"; values: StoredValue[] }
  | { ref: Ref; op: "empty" | "notEmpty" };

/** Describes a column of the result of a Projection. */
export type Output = { name: string; type: ColumnType } & (
  | { kind: "column"; ref: Ref }
  | { kind: "group"; ref: Ref; bucket?: Bucket }
  | { kind: "aggregate"; op: AggregateOp; ref?: Ref; by?: Ref }
);

/** Describes a Projection whose references all point at known Data Stores and columns. */
export interface ResolvedProjection {
  /** The `from` Data Store first, then the joined ones. */
  sources: [Source, ...Source[]];
  filters: ResolvedFilter[];
  outputs: Output[];
  /**
   * Is true if the Projection lists its columns. Without a list it reads every live column of
   * `from`.
   */
  hasSelect: boolean;
  isGrouped: boolean;
  sort: { name: string; desc: boolean }[];
  limit: number;
  slots: Record<string, string | string[]>;
}

/**
 * Describes a problem in a Projection. `missingColumn` is the key of an Archived column, and
 * `archivedStore` is the name of an Archived Data Store.
 */
export interface Problem extends Issue {
  missingColumn?: string;
  archivedStore?: string;
}

interface Resolver {
  db: Database;
  form: ProjectionForm;
  problems: Problem[];
  sources: Source[];
}

function liveStoreNames(db: Database): string[] {
  return db
    .all(z.object({ name: z.string() }), "SELECT name FROM stores WHERE archivedAt IS NULL")
    .map((s) => s.name);
}

/**
 * Adds the Data Store that `ref` names to the sources. In stored form an Archived Data Store is
 * added with a problem, so that the Projection can still be shown.
 */
function addSource(r: Resolver, ref: string, path: Path): Source | undefined {
  const store = storeRow(r.db, ref);
  if (!store) {
    const validValues = liveStoreNames(r.db);
    r.problems.push({ path, problem: `unknown Data Store "${ref}"`, validValues });
    return undefined;
  }
  if (r.sources.some((s) => s.store.id === store.id)) {
    r.problems.push({ path, problem: `Data Store "${store.name}" is already in the Projection` });
    return undefined;
  }
  if (store.archivedAt !== null) {
    r.problems.push({
      path,
      problem: `Data Store "${store.name}" is Archived`,
      archivedStore: store.name,
    });
    if (r.form === "readable") return undefined;
  }
  const source: Source = { alias: `t${r.sources.length}`, store };
  r.sources.push(source);
  return source;
}

function nameOf(form: ProjectionForm, source: Source): string {
  return form === "readable" ? source.store.name : source.store.id;
}

function sourceOf(r: Resolver, ref: string): { source: Source | undefined; column: string } {
  const dot = ref.lastIndexOf(".");
  if (dot === -1) return { source: r.sources[0], column: ref };
  const name = ref.slice(0, dot);
  const source = r.sources.find((s) => nameOf(r.form, s) === name || s.store.id === name);
  return { source, column: ref.slice(dot + 1) };
}

function refNames(r: Resolver): string[] {
  return r.sources.flatMap((source, index) =>
    liveColumns(source.store).map((c) =>
      index === 0 ? c.key : `${nameOf(r.form, source)}.${c.key}`,
    ),
  );
}

function storedColumn(r: Resolver, source: Source, physical: string, path: Path): Column {
  const column = source.store.columns.find((c) => c.physical === physical);
  if (!column) throw new Error(`Data Store ${source.store.id} has no column ${physical}`);
  if (column.archivedAt !== undefined) {
    r.problems.push({
      path,
      problem: `column "${column.key}" of "${source.store.name}" is Archived`,
      missingColumn: column.key,
    });
  }
  return column;
}

/** Returns the column that `ref` names, or `undefined` after adding a problem. */
function resolveRef(r: Resolver, ref: string, path: Path, within?: Source): Ref | undefined {
  const found = within ? { source: within, column: ref } : sourceOf(r, ref);
  const { source } = found;
  if (source && r.form === "stored") {
    return { source, column: storedColumn(r, source, found.column, path) };
  }
  const column = source && liveColumns(source.store).find((c) => c.key === found.column);
  if (source && column) return { source, column };
  const validValues = within ? liveColumns(within.store).map((c) => c.key) : refNames(r);
  r.problems.push({ path, problem: `unknown column "${ref}"`, validValues });
  return undefined;
}

function sameType(a: ColumnType, b: ColumnType): boolean {
  if (a.type === "money" && b.type === "money") return a.currency === b.currency;
  return a.type === b.type;
}

function resolveJoins(r: Resolver, joins: NonNullable<Projection["join"]>): void {
  for (const [index, join] of joins.entries()) {
    const path = ["join", index];
    const left = resolveRef(r, join.on.left, [...path, "on", "left"]);
    const source = addSource(r, join.store, [...path, "store"]);
    if (!source) continue;
    const right = resolveRef(r, join.on.right, [...path, "on", "right"], source);
    if (!left || !right) continue;
    if (!sameType(left.column, right.column)) {
      r.problems.push({
        path: [...path, "on"],
        problem: `"${join.on.left}" is ${left.column.type} and "${join.on.right}" is ${right.column.type}`,
        expected: "two columns of the same type",
      });
    }
    source.join = { type: join.type, left, right };
  }
}

function storedValue(r: Resolver, ref: Ref, value: unknown, path: Path): StoredValue | undefined {
  if (r.form === "stored") return StoredValue.parse(value);
  const parsed = parseValue(ref.column, value);
  if (parsed.ok) return parsed.stored;
  const { expected, validValues } = parsed;
  r.problems.push({
    path,
    problem: "the value does not fit the column",
    expected,
    ...(validValues && { validValues }),
  });
  return undefined;
}

function filterValue(r: Resolver, ref: Ref, value: unknown, path: Path) {
  if (typeof value !== "object" || value === null) return storedValue(r, ref, value, path);
  if (ref.column.type === "date" || ref.column.type === "datetime")
    return RelativeDate.parse(value);
  r.problems.push({ path, problem: "a relative value needs a date or datetime column" });
  return undefined;
}

function resolveFilter(r: Resolver, filter: z.output<typeof Filter>, path: Path): ResolvedFilter[] {
  const ref = resolveRef(r, filter.column, [...path, "column"]);
  if (!ref) return [];
  if ("values" in filter) {
    const values = filter.values.map((v, i) => storedValue(r, ref, v, [...path, "values", i]));
    return values.includes(undefined)
      ? []
      : [{ ref, op: "in", values: values.filter((v) => v !== undefined) }];
  }
  if (!("value" in filter)) return [{ ref, op: filter.op }];
  if (!["=", "!="].includes(filter.op) && !orderedTypes.has(ref.column.type)) {
    r.problems.push({
      path: [...path, "op"],
      problem: `${ref.column.type} columns are not ordered`,
      validValues: ["=", "!=", "in", "empty", "notEmpty"],
    });
  }
  const value = filterValue(r, ref, filter.value, [...path, "value"]);
  return value === undefined ? [] : [{ ref, op: filter.op, value }];
}

const numericTypes = new Set<ColumnType["type"]>(["number", "money"]);
const aggregateInputs: Record<AggregateOp, Set<ColumnType["type"]> | undefined> = {
  count: undefined,
  sum: numericTypes,
  avg: numericTypes,
  min: orderedTypes,
  max: orderedTypes,
  last: undefined,
};
const timeTypes = new Set<ColumnType["type"]>(["date", "datetime"]);

function addTypeProblem(
  r: Resolver,
  ref: Ref | undefined,
  allowed: Set<string> | undefined,
  path: Path,
) {
  if (!ref || !allowed || allowed.has(ref.column.type)) return;
  r.problems.push({
    path,
    problem: `"${ref.column.key}" is ${ref.column.type}`,
    expected: [...allowed].join(" or "),
  });
}

function columnType(column: Column): ColumnType {
  const {
    key: _key,
    label: _label,
    physical: _physical,
    archivedAt: _archivedAt,
    ...type
  } = column;
  return type;
}

function resolveGroups(r: Resolver, groups: NonNullable<Projection["groupBy"]>): Output[] {
  return groups.flatMap((group, index) => {
    const path = ["groupBy", index];
    const ref = resolveRef(r, group.column, [...path, "column"]);
    if (!ref) return [];
    const name = group.as ?? ref.column.key;
    if (group.bucket === undefined) {
      return [{ kind: "group", name, type: columnType(ref.column), ref }];
    }
    addTypeProblem(r, ref, timeTypes, [...path, "column"]);
    return [{ kind: "group", name, type: { type: "date" }, ref, bucket: group.bucket }];
  });
}

function resolveAggregateRefs(
  r: Resolver,
  aggregate: NonNullable<Projection["aggregate"]>[number],
  path: Path,
) {
  const needsColumn = aggregate.op !== "count";
  const needsBy = aggregate.op === "last";
  if (needsColumn && aggregate.column === undefined) {
    r.problems.push({ path: [...path, "column"], problem: `${aggregate.op} needs a column` });
  }
  if (needsBy !== (aggregate.by !== undefined)) {
    const problem = needsBy ? "last needs a date or datetime column in by" : "only last takes by";
    r.problems.push({ path: [...path, "by"], problem });
  }
  const ref =
    aggregate.column === undefined
      ? undefined
      : resolveRef(r, aggregate.column, [...path, "column"]);
  const by = aggregate.by === undefined ? undefined : resolveRef(r, aggregate.by, [...path, "by"]);
  addTypeProblem(r, ref, aggregateInputs[aggregate.op], [...path, "column"]);
  addTypeProblem(r, by, timeTypes, [...path, "by"]);
  return { ref, by };
}

function resolveAggregates(
  r: Resolver,
  aggregates: NonNullable<Projection["aggregate"]>,
): Output[] {
  return aggregates.map((aggregate, index): Output => {
    const { op } = aggregate;
    const { ref, by } = resolveAggregateRefs(r, aggregate, ["aggregate", index]);
    const name = aggregate.as ?? (ref ? `${op}_${ref.column.key}` : op);
    const type: ColumnType =
      op === "count" || !ref ? { type: "number", format: "plain" } : columnType(ref.column);
    return { kind: "aggregate", name, type, op, ...(ref && { ref }), ...(by && { by }) };
  });
}

function resolveSelect(r: Resolver, projection: Projection): Output[] {
  const isGrouped = projection.groupBy !== undefined || projection.aggregate !== undefined;
  if (isGrouped) {
    if (projection.select) {
      r.problems.push({
        path: ["select"],
        problem: "select cannot be used with groupBy or aggregate",
      });
    }
    return [
      ...resolveGroups(r, projection.groupBy ?? []),
      ...resolveAggregates(r, projection.aggregate ?? []),
    ];
  }
  const source = r.sources[0];
  const selected: { column: string; as?: string | undefined }[] =
    projection.select ??
    (source ? liveColumns(source.store).map((c) => ({ column: c.physical })) : []);
  const form = projection.select ? r.form : "stored";
  return selected.flatMap((item, index) => {
    const ref = resolveRef({ ...r, form }, item.column, ["select", index, "column"]);
    return ref
      ? [{ kind: "column", name: item.as ?? ref.column.key, type: columnType(ref.column), ref }]
      : [];
  });
}

/** Returns every output column name that `sort` and `slots` use, with its path. */
function outputNamesUsed(projection: Projection): [string, Path][] {
  const sorts = (projection.sort ?? []).map((s, i): [string, Path] => [
    s.column,
    ["sort", i, "column"],
  ]);
  const slots = Object.entries(projection.slots ?? {}).flatMap(([slot, value]): [string, Path][] =>
    Array.isArray(value)
      ? value.map((name, i) => [name, ["slots", slot, i]])
      : [[value, ["slots", slot]]],
  );
  return [...sorts, ...slots];
}

function addOutputProblems(r: Resolver, outputs: Output[], projection: Projection): void {
  const names = outputs.map((o) => o.name);
  for (const [index, name] of names.entries()) {
    if (names.indexOf(name) !== index) {
      r.problems.push({ path: [], problem: `two output columns are named "${name}", so set "as"` });
    }
  }
  for (const [name, path] of outputNamesUsed(projection)) {
    if (!names.includes(name)) {
      r.problems.push({ path, problem: `unknown output column "${name}"`, validValues: names });
    }
  }
}

/**
 * Returns the Projection with every reference resolved, and the problems in it. In readable form the
 * Projection is `undefined` if a reference is unknown. In stored form an Archived Data Store or
 * column is a problem, and the Projection is still returned.
 */
export function resolveProjection(
  db: Database,
  projection: Projection,
  form: ProjectionForm,
): { projection?: ResolvedProjection; problems: Problem[] } {
  const r: Resolver = { db, form, problems: [], sources: [] };
  addSource(r, projection.from, ["from"]);
  resolveJoins(r, projection.join ?? []);
  const filters = (projection.filter ?? []).flatMap((f, i) => resolveFilter(r, f, ["filter", i]));
  const outputs = resolveSelect(r, projection);
  addOutputProblems(r, outputs, projection);
  const [from, ...joined] = r.sources;
  if (!from || (form === "readable" && r.problems.length > 0)) {
    return { problems: r.problems };
  }
  const resolved: ResolvedProjection = {
    sources: [from, ...joined],
    filters,
    outputs,
    hasSelect: projection.select !== undefined,
    isGrouped: projection.groupBy !== undefined || projection.aggregate !== undefined,
    sort: (projection.sort ?? []).map((s) => ({ name: s.column, desc: s.desc ?? false })),
    limit: projection.limit ?? defaultLimit,
    slots: projection.slots ?? {},
  };
  return { projection: resolved, problems: r.problems };
}

function refIn(form: ProjectionForm, p: ResolvedProjection, ref: Ref): string {
  const column = form === "readable" ? ref.column.key : ref.column.physical;
  return ref.source === p.sources[0] ? column : `${nameOf(form, ref.source)}.${column}`;
}

function filterIn(form: ProjectionForm, p: ResolvedProjection, filter: ResolvedFilter) {
  const column = refIn(form, p, filter.ref);
  const value = (v: StoredValue) => (form === "readable" ? formatValue(filter.ref.column, v) : v);
  if (!("value" in filter) && !("values" in filter)) return { column, op: filter.op };
  if ("values" in filter) return { column, op: filter.op, values: filter.values.map(value) };
  const written = isRelative(filter.value) ? filter.value : value(filter.value);
  return { column, op: filter.op, value: written };
}

function outputIn(form: ProjectionForm, p: ResolvedProjection, output: Output) {
  const ref = (r: Ref | undefined) => r && refIn(form, p, r);
  switch (output.kind) {
    case "column":
      return { column: ref(output.ref), as: output.name };
    case "group":
      return { column: ref(output.ref), bucket: output.bucket, as: output.name };
    case "aggregate":
      return { op: output.op, column: ref(output.ref), by: ref(output.by), as: output.name };
  }
}

function nonEmpty<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

/**
 * Returns the Projection as JSON in `form`. Readable form names Data Stores and columns by their
 * current names and keys, so a renamed column shows its new key.
 */
export function formatProjection(p: ResolvedProjection, form: ProjectionForm): unknown {
  const outputs = (kind: Output["kind"]) =>
    nonEmpty(p.outputs.filter((o) => o.kind === kind).map((o) => outputIn(form, p, o)));
  const written = {
    from: nameOf(form, p.sources[0]),
    join: nonEmpty(
      p.sources.flatMap((s) =>
        s.join
          ? [
              {
                store: nameOf(form, s),
                type: s.join.type,
                on: {
                  left: refIn(form, p, s.join.left),
                  right:
                    form === "readable" ? s.join.right.column.key : s.join.right.column.physical,
                },
              },
            ]
          : [],
      ),
    ),
    select: p.hasSelect ? outputs("column") : undefined,
    filter: nonEmpty(p.filters.map((f) => filterIn(form, p, f))),
    groupBy: outputs("group"),
    aggregate: outputs("aggregate"),
    sort: nonEmpty(
      p.sort.map((s) => (s.desc ? { column: s.name, desc: true } : { column: s.name })),
    ),
    limit: p.limit === defaultLimit ? undefined : p.limit,
    slots: Object.keys(p.slots).length > 0 ? p.slots : undefined,
  };
  // The round trip drops the parts that are `undefined`.
  return JSON.parse(JSON.stringify(written));
}

/** Returns the ids of the Data Stores that a Projection in stored form reads. */
export function storesRead(stored: Projection): string[] {
  return [stored.from, ...(stored.join ?? []).map((j) => j.store)];
}

/**
 * Returns a Projection that an Agent wrote, with every reference resolved. Returns `undefined` if
 * the Projection has problems, after it adds each one to `issues` with `path` in front.
 */
export function resolveReadableProjection(
  db: Database,
  input: unknown,
  path: Path,
  issues: Issue[],
): ResolvedProjection | undefined {
  const parsed = Projection.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ path: [...path, ...issue.path.map(String)], problem: issue.message });
    }
    return undefined;
  }
  const { projection, problems } = resolveProjection(db, parsed.data, "readable");
  issues.push(...problems.map((p) => ({ ...p, path: [...path, ...p.path] })));
  return problems.length === 0 ? projection : undefined;
}

/**
 * Returns a Projection that an Agent wrote in stored form. Returns `undefined` if the Projection
 * has problems, after it adds each one to `issues` with `path` in front.
 */
export function storedProjection(
  db: Database,
  input: unknown,
  path: Path,
  issues: Issue[],
): Projection | undefined {
  const projection = resolveReadableProjection(db, input, path, issues);
  return projection && Projection.parse(formatProjection(projection, "stored"));
}

/** Describes why a Widget cannot read its Data Stores. */
export interface Broken {
  reason: string;
  missingColumn?: string;
  archivedStore?: string;
}

/**
 * Returns a stored Projection in readable form, and why it is broken if it reads an Archived Data Store
 * or column, or if a slot or sort names an output column that is missing.
 */
export function presentProjection(
  db: Database,
  stored: Projection,
): { projection: unknown; broken?: Broken } {
  const { projection, problems } = resolveProjection(db, stored, "stored");
  const [problem] = problems;
  const broken: Broken | undefined = problem && {
    reason: problem.problem,
    ...(problem.missingColumn !== undefined && { missingColumn: problem.missingColumn }),
    ...(problem.archivedStore !== undefined && { archivedStore: problem.archivedStore }),
  };
  const written = projection ? formatProjection(projection, "readable") : stored;
  return broken ? { projection: written, broken } : { projection: written };
}
