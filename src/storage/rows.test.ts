import { expect } from "vitest";
import { failureOf, test } from "./fixture.ts";
import type { Storage } from "./storage.ts";

function createBudget(storage: Storage) {
  storage.createStore({
    name: "budget",
    columns: [
      { key: "month", type: "date" },
      { key: "category", type: "enum", options: [{ label: "rent" }, { label: "food" }] },
      { key: "amount", type: "money", currency: "EUR" },
      { key: "paid", type: "boolean" },
    ],
    key: ["month", "category"],
  });
}

test("appended rows read back in the Agent's value forms", ({ storage }) => {
  createBudget(storage);
  storage.appendRows({
    store: "budget",
    rows: [{ month: "2026-01-01", category: "rent", amount: 950.5, paid: true }],
  });
  expect(storage.listRows("budget")).toMatchObject([
    {
      id: 1,
      version: 1,
      values: { month: "2026-01-01", category: "rent", amount: 950.5, paid: true },
    },
  ]);
});

test("bad values fail with invalid listing every bad row, and nothing is written", ({
  storage,
}) => {
  createBudget(storage);
  const failure = failureOf(() =>
    storage.appendRows({
      store: "budget",
      rows: [{ month: "2026-01-01", amount: 1 }, { amount: 1.234 }, { colour: "red" }],
    }),
  );
  expect(failure.details.issues?.map((i) => i.path)).toEqual([
    ["rows", 1, "amount"],
    ["rows", 2, "colour"],
  ]);
  expect(storage.listRows("budget")).toEqual([]);
});

test("more than 1,000 rows in one append is invalid", ({ storage }) => {
  createBudget(storage);
  const rows = Array.from({ length: 1001 }, () => ({}));
  expect(failureOf(() => storage.appendRows({ store: "budget", rows })).code).toBe("invalid");
});

test("appending a row whose Key exists fails with conflict by default, returning the match", ({
  storage,
}) => {
  createBudget(storage);
  storage.appendRows({
    store: "budget",
    rows: [{ month: "2026-01-01", category: "rent", amount: 900 }],
  });
  const failure = failureOf(() =>
    storage.appendRows({
      store: "budget",
      rows: [
        { month: "2026-02-01", category: "rent", amount: 900 },
        { month: "2026-01-01", category: "rent", amount: 950 },
      ],
    }),
  );
  expect(failure.code).toBe("conflict");
  expect(failure.details.current).toMatchObject([
    { index: 1, row: { id: 1, values: { amount: 900 } } },
  ]);
  expect(storage.listRows("budget")).toHaveLength(1);
});

test("onConflict update re-syncs matching rows, so repeating the append changes nothing", ({
  storage,
}) => {
  createBudget(storage);
  storage.appendRows({
    store: "budget",
    rows: [{ month: "2026-01-01", category: "rent", amount: 900 }],
  });
  const sync = {
    store: "budget",
    onConflict: "update" as const,
    rows: [{ month: "2026-01-01", category: "rent", amount: 950 }],
  };
  expect(storage.appendRows(sync)).toEqual({ inserted: [], updated: [1], skipped: [] });
  storage.appendRows(sync);
  expect(storage.listRows("budget").map((r) => r.values.amount)).toEqual([950]);
});

test("onConflict skip keeps matching rows and appends the rest", ({ storage }) => {
  createBudget(storage);
  storage.appendRows({
    store: "budget",
    rows: [{ month: "2026-01-01", category: "rent", amount: 900 }],
  });
  const result = storage.appendRows({
    store: "budget",
    onConflict: "skip",
    rows: [
      { month: "2026-01-01", category: "rent", amount: 1 },
      { month: "2026-01-01", category: "food", amount: 300 },
    ],
  });
  expect(result).toEqual({ inserted: [2], updated: [], skipped: [1] });
  expect(storage.listRows("budget").map((r) => r.values.amount)).toEqual([900, 300]);
});

test("updating a row changes only the given values and bumps its version", ({ storage }) => {
  createBudget(storage);
  storage.appendRows({
    store: "budget",
    rows: [{ month: "2026-01-01", category: "rent", amount: 900 }],
  });
  const [row] = storage.updateRows({
    store: "budget",
    rows: [{ id: 1, expectedVersion: 1, values: { paid: true } }],
  });
  expect(row).toMatchObject({ version: 2, values: { amount: 900, paid: true } });
});

test("updating a row with a stale version fails with conflict and returns the row", ({
  storage,
}) => {
  createBudget(storage);
  storage.appendRows({ store: "budget", rows: [{ month: "2026-01-01", amount: 900 }] });
  storage.updateRows({
    store: "budget",
    rows: [{ id: 1, expectedVersion: 1, values: { amount: 1 } }],
  });
  const failure = failureOf(() =>
    storage.updateRows({
      store: "budget",
      rows: [{ id: 1, expectedVersion: 1, values: { amount: 2 } }],
    }),
  );
  expect(failure.details.current).toMatchObject({ version: 2, values: { amount: 1 } });
});

test("updating a row onto another row's Key fails with conflict", ({ storage }) => {
  createBudget(storage);
  storage.appendRows({
    store: "budget",
    rows: [
      { month: "2026-01-01", category: "rent" },
      { month: "2026-01-01", category: "food" },
    ],
  });
  const failure = failureOf(() =>
    storage.updateRows({
      store: "budget",
      rows: [{ id: 2, expectedVersion: 1, values: { category: "rent" } }],
    }),
  );
  expect(failure.code).toBe("conflict");
});

test("an Archived row is no longer listed and frees its Key", ({ storage }) => {
  createBudget(storage);
  storage.appendRows({
    store: "budget",
    rows: [{ month: "2026-01-01", category: "rent", amount: 900 }],
  });
  storage.archiveRow({ store: "budget", id: 1, expectedVersion: 1 });
  storage.appendRows({
    store: "budget",
    rows: [{ month: "2026-01-01", category: "rent", amount: 950 }],
  });
  expect(storage.listRows("budget").map((r) => r.id)).toEqual([2]);
  expect(storage.listRows("budget", { archived: true }).map((r) => r.id)).toEqual([1]);
});

test("restoring a row whose Key a live row took fails with conflict", ({ storage }) => {
  createBudget(storage);
  storage.appendRows({ store: "budget", rows: [{ month: "2026-01-01", category: "rent" }] });
  storage.archiveRow({ store: "budget", id: 1, expectedVersion: 1 });
  storage.appendRows({ store: "budget", rows: [{ month: "2026-01-01", category: "rent" }] });
  expect(
    failureOf(() => storage.restoreRow({ store: "budget", id: 1, expectedVersion: 2 })).code,
  ).toBe("conflict");
});

test("an unknown row is not_found", ({ storage }) => {
  createBudget(storage);
  expect(
    failureOf(() => storage.archiveRow({ store: "budget", id: 9, expectedVersion: 1 })).code,
  ).toBe("not_found");
});
