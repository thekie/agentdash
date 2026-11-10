import { expect } from "vitest";
import type { Issue } from "./errors.ts";
import { failureOf, test } from "./fixture.ts";
import type { ProjectionInput } from "./projection.ts";
import { createStorage, type Storage } from "./storage.ts";

function clockedStorage(now: string) {
  const storage = createStorage(":memory:", { now: () => now });
  return Object.assign(storage, { [Symbol.dispose]: storage.close });
}

function createWeightLog(storage: Storage) {
  storage.createStore({
    name: "weight_log",
    columns: [
      { key: "day", type: "date" },
      { key: "kg", type: "number", unit: "kg" },
      { key: "note", type: "text" },
    ],
  });
  storage.appendRows({
    store: "weight_log",
    rows: [
      { day: "2026-01-05", kg: 80, note: "start" },
      { day: "2026-01-07", kg: 79 },
      { day: "2026-01-14", kg: 78 },
    ],
  });
}

test("a Projection without select returns every live column in order", ({ storage }) => {
  createWeightLog(storage);
  const result = storage.query({ from: "weight_log" });
  expect(result.columns).toEqual([
    { name: "day", type: { type: "date" } },
    { name: "kg", type: { type: "number", format: "plain", unit: "kg" } },
    { name: "note", type: { type: "text" } },
  ]);
  expect(result.rows).toEqual([
    { day: "2026-01-05", kg: 80, note: "start" },
    { day: "2026-01-07", kg: 79, note: null },
    { day: "2026-01-14", kg: 78, note: null },
  ]);
  expect(result.truncated).toBe(false);
});

test("select, sort and limit shape the rows of a raw Projection", ({ storage }) => {
  createWeightLog(storage);
  const result = storage.query({
    from: "weight_log",
    select: [{ column: "day" }, { column: "kg", as: "weight" }],
    sort: [{ column: "weight" }],
    limit: 2,
  });
  expect(result.rows).toEqual([
    { day: "2026-01-14", weight: 78 },
    { day: "2026-01-07", weight: 79 },
  ]);
  expect(result.truncated).toBe(true);
});

test("a query returns 100 rows unless the Projection sets a limit", ({ storage }) => {
  storage.createStore({ name: "steps", columns: [{ key: "n", type: "number" }] });
  storage.appendRows({ store: "steps", rows: Array.from({ length: 101 }, (_, n) => ({ n })) });
  const result = storage.query({ from: "steps" });
  expect(result.rows).toHaveLength(100);
  expect(result.truncated).toBe(true);
});

function createBudget(storage: Storage) {
  storage.createStore({
    name: "budget",
    columns: [
      { key: "month", type: "date" },
      { key: "category", type: "enum", options: [{ label: "rent" }, { label: "food" }] },
      { key: "amount", type: "money", currency: "EUR" },
      { key: "paid", type: "boolean" },
    ],
  });
  storage.appendRows({
    store: "budget",
    rows: [
      { month: "2026-01-01", category: "rent", amount: 950.5, paid: true },
      { month: "2026-01-01", category: "food", amount: 320.25, paid: false },
      { month: "2026-02-01", category: "rent", amount: 950.5 },
    ],
  });
}

type Filter = NonNullable<ProjectionInput["filter"]>[number];

test.for<[Filter, number[]]>([
  [{ column: "category", op: "=", value: "food" }, [320.25]],
  [{ column: "amount", op: ">", value: 900 }, [950.5, 950.5]],
  [{ column: "category", op: "in", values: ["rent"] }, [950.5, 950.5]],
  [{ column: "paid", op: "empty" }, [950.5]],
  [{ column: "paid", op: "notEmpty" }, [950.5, 320.25]],
  [{ column: "paid", op: "!=", value: true }, [320.25]],
])("filter %j keeps the matching rows", ([filter, amounts], { storage }) => {
  createBudget(storage);
  const result = storage.query({
    from: "budget",
    select: [{ column: "amount" }],
    filter: [filter],
  });
  expect(result.rows.map((r) => r.amount)).toEqual(amounts);
});

test("a relative filter counts from today", () => {
  using storage = clockedStorage("2026-01-20T10:00:00.000Z");
  createWeightLog(storage);
  const result = storage.query({
    from: "weight_log",
    select: [{ column: "day" }],
    filter: [{ column: "day", op: ">=", value: { relative: "-1w" } }],
  });
  expect(result.rows).toEqual([{ day: "2026-01-14" }]);
});

test("groupBy with a week bucket averages per week, starting on Monday", ({ storage }) => {
  createWeightLog(storage);
  const result = storage.query({
    from: "weight_log",
    groupBy: [{ column: "day", bucket: "week", as: "week" }],
    aggregate: [
      { op: "avg", column: "kg" },
      { op: "count" },
      { op: "last", column: "kg", by: "day", as: "latest" },
    ],
  });
  expect(result.columns).toEqual([
    { name: "week", type: { type: "date" } },
    { name: "avg_kg", type: { type: "number", format: "plain", unit: "kg" } },
    { name: "count", type: { type: "number", format: "plain" } },
    { name: "latest", type: { type: "number", format: "plain", unit: "kg" } },
  ]);
  expect(result.rows.map(Object.values)).toEqual([
    ["2026-01-05", 79.5, 2, 79],
    ["2026-01-12", 78, 1, 78],
  ]);
});

test.for([
  ["day", "2026-05-17"],
  ["month", "2026-05-01"],
  ["quarter", "2026-04-01"],
  ["year", "2026-01-01"],
] as const)("a %s bucket starts at %s for 2026-05-17T23:30Z", ([bucket, start], { storage }) => {
  storage.createStore({ name: "events", columns: [{ key: "at", type: "datetime" }] });
  storage.appendRows({ store: "events", rows: [{ at: "2026-05-17T23:30:00Z" }] });
  const result = storage.query({
    from: "events",
    groupBy: [{ column: "at", bucket, as: "start" }],
  });
  expect(result.rows).toEqual([{ start }]);
});

test("aggregates without groupBy give one row", ({ storage }) => {
  createBudget(storage);
  const result = storage.query({
    from: "budget",
    aggregate: [
      { op: "sum", column: "amount", as: "total" },
      { op: "max", column: "month" },
    ],
  });
  expect(result.columns.map((c) => c.name)).toEqual(["total", "max_month"]);
  expect(result.rows.map(Object.values)).toEqual([[2221.25, "2026-02-01"]]);
});

test("groupBy without a bucket groups by the value, sorted by the groups", ({ storage }) => {
  createBudget(storage);
  const result = storage.query({
    from: "budget",
    groupBy: [{ column: "category" }],
    aggregate: [{ op: "sum", column: "amount" }],
    sort: [{ column: "sum_amount", desc: true }],
  });
  expect(result.rows.map(Object.values)).toEqual([
    ["rent", 1901],
    ["food", 320.25],
  ]);
});

function createLimits(storage: Storage) {
  storage.createStore({
    name: "limits",
    columns: [
      { key: "category", type: "enum", options: [{ label: "rent" }, { label: "travel" }] },
      { key: "cap", type: "money", currency: "EUR" },
    ],
  });
  storage.appendRows({ store: "limits", rows: [{ category: "rent", cap: 1000 }] });
}

test("an inner join keeps only the rows that match", ({ storage }) => {
  createBudget(storage);
  createLimits(storage);
  const result = storage.query({
    from: "budget",
    join: [{ store: "limits", on: { left: "category", right: "category" } }],
    select: [{ column: "month" }, { column: "amount" }, { column: "limits.cap" }],
  });
  expect(result.rows).toEqual([
    { month: "2026-01-01", amount: 950.5, cap: 1000 },
    { month: "2026-02-01", amount: 950.5, cap: 1000 },
  ]);
});

test("a left join keeps rows without a match", ({ storage }) => {
  createBudget(storage);
  createLimits(storage);
  const result = storage.query({
    from: "budget",
    join: [{ store: "limits", type: "left", on: { left: "category", right: "category" } }],
    select: [{ column: "category" }, { column: "limits.cap" }],
    filter: [{ column: "month", op: "=", value: "2026-01-01" }],
  });
  expect(result.rows).toEqual([
    { category: "rent", cap: 1000 },
    { category: "food", cap: null },
  ]);
});

test("Archived rows are left out, also from a joined Data Store", ({ storage }) => {
  createBudget(storage);
  createLimits(storage);
  storage.archiveRow({ store: "budget", id: 2, expectedVersion: 1 });
  storage.archiveRow({ store: "limits", id: 1, expectedVersion: 1 });
  const result = storage.query({
    from: "budget",
    join: [{ store: "limits", type: "left", on: { left: "category", right: "category" } }],
    select: [{ column: "category" }, { column: "limits.cap" }],
  });
  expect(result.rows).toEqual([
    { category: "rent", cap: null },
    { category: "rent", cap: null },
  ]);
});

test.for<[ProjectionInput, Partial<Issue>]>([
  [
    { from: "weight_lgo" },
    { path: ["from"], problem: 'unknown Data Store "weight_lgo"', validValues: ["weight_log"] },
  ],
  [
    { from: "weight_log", select: [{ column: "weight" }] },
    { path: ["select", 0, "column"], validValues: ["day", "kg", "note"] },
  ],
  [
    { from: "weight_log", filter: [{ column: "kg", op: ">", value: "heavy" }] },
    { path: ["filter", 0, "value"], expected: "a finite number" },
  ],
  [
    { from: "weight_log", filter: [{ column: "kg", op: ">", value: { relative: "-1d" } }] },
    { path: ["filter", 0, "value"] },
  ],
  [
    { from: "weight_log", aggregate: [{ op: "sum", column: "note" }] },
    { path: ["aggregate", 0, "column"], expected: "number or money" },
  ],
  [
    { from: "weight_log", aggregate: [{ op: "last", column: "kg" }] },
    { path: ["aggregate", 0, "by"] },
  ],
  [
    { from: "weight_log", groupBy: [{ column: "kg", bucket: "week" }] },
    { path: ["groupBy", 0, "column"], expected: "date or datetime" },
  ],
  [
    { from: "weight_log", groupBy: [{ column: "day" }], select: [{ column: "kg" }] },
    { path: ["select"] },
  ],
  [
    { from: "weight_log", select: [{ column: "kg" }], sort: [{ column: "day" }] },
    { path: ["sort", 0, "column"], validValues: ["kg"] },
  ],
  [
    { from: "weight_log", select: [{ column: "kg" }], slots: { y: ["kg", "fat"] } },
    { path: ["slots", "y", 1], validValues: ["kg"] },
  ],
  [
    { from: "weight_log", select: [{ column: "kg" }, { column: "day", as: "kg" }] },
    { problem: 'two output columns are named "kg", so set "as"' },
  ],
  [
    { from: "weight_log", join: [{ store: "weight_log", on: { left: "day", right: "day" } }] },
    { path: ["join", 0, "store"] },
  ],
  [
    { from: "weight_log", aggregate: [{ op: "sum" }] },
    { path: ["aggregate", 0, "column"], problem: "sum needs a column" },
  ],
  [
    { from: "weight_log", aggregate: [{ op: "count", by: "day" }] },
    { path: ["aggregate", 0, "by"], problem: "only last takes by" },
  ],
])("%j is invalid", ([projection, issue], { storage }) => {
  createWeightLog(storage);
  const failure = failureOf(() => storage.query(projection));
  expect(failure.code).toBe("invalid");
  expect(failure.details.issues).toContainEqual(expect.objectContaining(issue));
});

test("a join on columns of different types is invalid", ({ storage }) => {
  createWeightLog(storage);
  createBudget(storage);
  const failure = failureOf(() =>
    storage.query({
      from: "weight_log",
      join: [{ store: "budget", on: { left: "day", right: "amount" } }],
    }),
  );
  expect(failure.details.issues).toMatchObject([{ path: ["join", 0, "on"] }]);
});

test("a query of an Archived Data Store is invalid", ({ storage }) => {
  createWeightLog(storage);
  const store = storage.store("weight_log");
  storage.archiveStore({ id: store.id, expectedVersion: store.version });
  const failure = failureOf(() => storage.query({ from: store.id }));
  expect(failure.details.issues).toMatchObject([
    { problem: 'Data Store "weight_log" is Archived' },
  ]);
});

test("ordering a boolean is invalid", ({ storage }) => {
  createBudget(storage);
  const failure = failureOf(() =>
    storage.query({ from: "budget", filter: [{ column: "paid", op: "<", value: true }] }),
  );
  expect(failure.details.issues).toMatchObject([
    { path: ["filter", 0, "op"], validValues: ["=", "!=", "in", "empty", "notEmpty"] },
  ]);
});

test("an unknown column lists the joined columns as store.key", ({ storage }) => {
  createBudget(storage);
  createLimits(storage);
  const failure = failureOf(() =>
    storage.query({
      from: "budget",
      join: [{ store: "limits", on: { left: "category", right: "kind" } }],
      select: [{ column: "limits.limit" }],
    }),
  );
  expect(failure.details.issues).toMatchObject([
    { path: ["join", 0, "on", "right"], validValues: ["category", "cap"] },
    {
      path: ["select", 0, "column"],
      validValues: ["month", "category", "amount", "paid", "limits.category", "limits.cap"],
    },
  ]);
});

test("a relative month ends on the last day of a shorter month", () => {
  using storage = clockedStorage("2026-03-31T10:00:00.000Z");
  storage.createStore({ name: "days", columns: [{ key: "day", type: "date" }] });
  storage.appendRows({ store: "days", rows: [{ day: "2026-02-28" }, { day: "2026-03-01" }] });
  const result = storage.query({
    from: "days",
    filter: [{ column: "day", op: "<", value: { relative: "-1m" } }],
  });
  expect(result.rows).toEqual([]);
});

test("a join's left column must come from a Data Store before it", ({ storage }) => {
  createBudget(storage);
  createLimits(storage);
  const failure = failureOf(() =>
    storage.query({
      from: "budget",
      join: [{ store: "limits", on: { left: "limits.category", right: "category" } }],
    }),
  );
  expect(failure.details.issues).toMatchObject([{ path: ["join", 0, "on", "left"] }]);
});

test("a Projection of the wrong shape is invalid with its path", ({ storage }) => {
  createWeightLog(storage);
  const failure = failureOf(() => storage.query({ from: "weight_log", limit: 5000 }));
  expect(failure.code).toBe("invalid");
  expect(failure.details.issues).toMatchObject([{ path: ["limit"] }]);
});

function createLabelledBudget(storage: Storage) {
  storage.createStore({
    name: "spend",
    columns: [
      { key: "month", label: "Month", type: "date" },
      { key: "amount", label: "Amount", type: "money", currency: "EUR" },
      { key: "note", type: "text" },
    ],
  });
}

test("a column is labelled by the Projection, else by its Data Store", ({ storage }) => {
  createLabelledBudget(storage);
  const result = storage.query({
    from: "spend",
    select: [
      { column: "month" },
      { column: "amount", as: "spent" },
      { column: "note", label: "Note" },
      { column: "amount", as: "raw", label: "Amount (EUR)" },
    ],
  });
  expect(result.columns.map(({ name, label }) => [name, label])).toEqual([
    ["month", "Month"],
    ["spent", "Amount"],
    ["note", "Note"],
    ["raw", "Amount (EUR)"],
  ]);
});

test("an aggregate is labelled only by the Projection", ({ storage }) => {
  createLabelledBudget(storage);
  const result = storage.query({
    from: "spend",
    groupBy: [{ column: "month", bucket: "year", as: "year", label: "Year" }, { column: "note" }],
    aggregate: [
      { op: "sum", column: "amount" },
      { op: "count", label: "Payments" },
    ],
  });
  expect(result.columns.map(({ name, label }) => [name, label])).toEqual([
    ["year", "Year"],
    ["note", undefined],
    ["sum_amount", undefined],
    ["count", "Payments"],
  ]);
});
