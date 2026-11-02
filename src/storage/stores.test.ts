import { expect } from "vitest";
import { failureOf, test } from "./fixture.ts";
import type { Storage } from "./storage.ts";

function createWeightLog(storage: Storage) {
  return storage.createStore({
    name: "weight",
    columns: [
      { key: "day", type: "date" },
      { key: "kg", type: "number", unit: "kg" },
      { key: "note", type: "text" },
    ],
    key: ["day"],
  });
}

test("a Data Store is found by name with its columns and Key", ({ storage }) => {
  const store = createWeightLog(storage);
  expect(storage.store("weight")).toMatchObject({
    id: store.id,
    key: ["day"],
    rowCount: 0,
    version: 1,
    columns: [
      { key: "day", type: "date" },
      { key: "kg", type: "number", format: "plain", unit: "kg" },
      { key: "note", type: "text" },
    ],
  });
});

test("creating a Data Store with a taken name fails with conflict and returns it", ({
  storage,
}) => {
  const store = createWeightLog(storage);
  const failure = failureOf(() => createWeightLog(storage));
  expect(failure.code).toBe("conflict");
  expect(failure.details.current).toMatchObject({ id: store.id });
});

test("duplicate column keys and an unknown Key column are invalid", ({ storage }) => {
  const failure = failureOf(() =>
    storage.createStore({
      name: "x",
      columns: [
        { key: "a", type: "text" },
        { key: "a", type: "boolean" },
      ],
      key: ["b"],
    }),
  );
  expect(failure.details.issues?.map((i) => i.path)).toEqual([
    ["columns", 1, "key"],
    ["key", 0],
  ]);
});

test("an added column reads as empty on existing rows", ({ storage }) => {
  const store = createWeightLog(storage);
  storage.appendRows({ store: "weight", rows: [{ day: "2026-01-01", kg: 80 }] });
  storage.alterStore({
    store: store.id,
    expectedVersion: 1,
    ops: [{ op: "add_column", column: { key: "fasted", type: "boolean" } }],
  });
  expect(storage.rows("weight")[0]?.values).toMatchObject({ fasted: null, kg: 80 });
});

test("a renamed column keeps its values under the new key", ({ storage }) => {
  const store = createWeightLog(storage);
  storage.appendRows({ store: "weight", rows: [{ day: "2026-01-01", kg: 80 }] });
  storage.alterStore({
    store: store.id,
    expectedVersion: 1,
    ops: [{ op: "rename_column", column: "kg", to: "weight" }],
  });
  expect(storage.rows("weight")[0]?.values).toEqual({
    day: "2026-01-01",
    weight: 80,
    note: null,
  });
});

test("a retype dry run reports values that would not convert and changes nothing", ({
  storage,
}) => {
  const store = createWeightLog(storage);
  storage.appendRows({
    store: "weight",
    rows: [
      { day: "2026-01-01", note: "12" },
      { day: "2026-01-02", note: "heavy" },
    ],
  });
  const { reports } = storage.alterStore({
    store: store.id,
    expectedVersion: 1,
    dryRun: true,
    ops: [{ op: "retype_column", column: "note", to: { type: "number" } }],
  });
  expect(reports[0]?.unconverted).toEqual({ count: 1, rows: [{ id: 2, value: "heavy" }] });
  expect(storage.store("weight")).toMatchObject({
    version: 1,
    columns: [{}, {}, { key: "note", type: "text" }],
  });
});

test("a retype converts values, empties the rest and Archives the old column", ({ storage }) => {
  const store = createWeightLog(storage);
  storage.appendRows({
    store: "weight",
    rows: [
      { day: "2026-01-01", note: "12" },
      { day: "2026-01-02", note: "heavy" },
    ],
  });
  const { store: altered } = storage.alterStore({
    store: store.id,
    expectedVersion: 1,
    ops: [{ op: "retype_column", column: "note", to: { type: "number" } }],
  });
  expect(storage.rows("weight").map((r) => r.values.note)).toEqual([12, null]);
  expect(altered.archivedColumns).toMatchObject([{ key: "note", type: "text" }]);
  expect(altered.version).toBe(2);
});

test("an Archived column is no longer read", ({ storage }) => {
  const store = createWeightLog(storage);
  storage.alterStore({
    store: store.id,
    expectedVersion: 1,
    ops: [{ op: "archive_column", column: "note" }],
  });
  expect(storage.store("weight").columns.map((c) => c.key)).toEqual(["day", "kg"]);
});

test("a Key column cannot be Archived", ({ storage }) => {
  const store = createWeightLog(storage);
  const failure = failureOf(() =>
    storage.alterStore({
      store: store.id,
      expectedVersion: 1,
      ops: [{ op: "archive_column", column: "day" }],
    }),
  );
  expect(failure.code).toBe("invalid");
});

test("setting a Key that live rows share fails with conflict listing them", ({ storage }) => {
  storage.createStore({
    name: "steps",
    columns: [
      { key: "day", type: "date" },
      { key: "n", type: "number" },
    ],
  });
  storage.appendRows({
    store: "steps",
    rows: [{ day: "2026-01-01" }, { day: "2026-01-01" }, { day: "2026-01-02" }],
  });
  const failure = failureOf(() =>
    storage.alterStore({
      store: "steps",
      expectedVersion: 1,
      ops: [{ op: "set_key", columns: ["day"] }],
    }),
  );
  expect(failure.code).toBe("conflict");
  expect(failure.details.current).toEqual([{ values: { day: "2026-01-01" }, rowIds: [1, 2] }]);
});

test("ops apply all or none", ({ storage }) => {
  const store = createWeightLog(storage);
  failureOf(() =>
    storage.alterStore({
      store: store.id,
      expectedVersion: 1,
      ops: [
        { op: "add_column", column: { key: "mood", type: "text" } },
        { op: "rename_column", column: "missing", to: "x" },
      ],
    }),
  );
  expect(storage.store(store.id)).toMatchObject({ version: 1, columns: [{}, {}, {}] });
  const again = storage.alterStore({
    store: store.id,
    expectedVersion: 1,
    ops: [{ op: "add_column", column: { key: "mood", type: "text" } }],
  });
  expect(again.store.columns.map((c) => c.key)).toEqual(["day", "kg", "note", "mood"]);
});

test("an enum option left out is Archived: old rows keep its label, new rows cannot use it", ({
  storage,
}) => {
  const store = storage.createStore({
    name: "mood",
    columns: [{ key: "feeling", type: "enum", options: [{ label: "good" }, { label: "bad" }] }],
  });
  storage.appendRows({ store: "mood", rows: [{ feeling: "bad" }] });
  storage.alterStore({
    store: store.id,
    expectedVersion: 1,
    ops: [
      {
        op: "set_enum_options",
        column: "feeling",
        options: [{ label: "good" }, { label: "okay" }],
      },
    ],
  });
  expect(storage.rows("mood")[0]?.values).toEqual({ feeling: "bad" });
  expect(
    failureOf(() => storage.appendRows({ store: "mood", rows: [{ feeling: "bad" }] })).code,
  ).toBe("invalid");
});

test("an Archived Data Store refuses writes and is listed as Archived", ({ storage }) => {
  const store = createWeightLog(storage);
  storage.archiveStore({ id: store.id, expectedVersion: 1 });
  expect(failureOf(() => storage.appendRows({ store: store.id, rows: [{}] })).code).toBe(
    "archived",
  );
  expect(storage.stores()).toEqual([]);
  expect(storage.archived().stores.map((s) => s.id)).toEqual([store.id]);
});

test("restoring a Data Store whose name was taken fails with conflict", ({ storage }) => {
  const old = createWeightLog(storage);
  storage.archiveStore({ id: old.id, expectedVersion: 1 });
  createWeightLog(storage);
  expect(failureOf(() => storage.restoreStore({ id: old.id, expectedVersion: 2 })).code).toBe(
    "conflict",
  );
});

test("altering with a stale version fails with conflict", ({ storage }) => {
  const store = createWeightLog(storage);
  const failure = failureOf(() =>
    storage.alterStore({ store: store.id, expectedVersion: 7, ops: [] }),
  );
  expect(failure.code).toBe("conflict");
});

test("a retype reports only live rows that will not convert", ({ storage }) => {
  const store = createWeightLog(storage);
  storage.appendRows({
    store: "weight",
    rows: [
      { day: "2026-01-01", note: "old" },
      { day: "2026-01-02", note: "heavy" },
    ],
  });
  storage.archiveRow({ store: "weight", id: 1, expectedVersion: 1 });
  const { reports } = storage.alterStore({
    store: store.id,
    expectedVersion: 1,
    dryRun: true,
    ops: [{ op: "retype_column", column: "note", to: { type: "number" } }],
  });
  expect(reports[0]?.unconverted).toEqual({ count: 1, rows: [{ id: 2, value: "heavy" }] });
});
