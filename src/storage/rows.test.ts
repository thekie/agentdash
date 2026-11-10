import { expect } from "vitest";
import { failureOf, test } from "./fixture.ts";
import { createStorage, type Storage } from "./storage.ts";

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
  expect(storage.rows("budget")).toMatchObject([
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
  expect(storage.rows("budget")).toEqual([]);
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
  expect(storage.rows("budget")).toHaveLength(1);
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
  expect(storage.appendRows(sync)).toEqual({
    inserted: [],
    updated: [{ id: 1, version: 2 }],
    skipped: [],
  });
  storage.appendRows(sync);
  expect(storage.rows("budget").map((r) => r.values.amount)).toEqual([950]);
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
  expect(result).toEqual({ inserted: [{ id: 2, version: 1 }], updated: [], skipped: [1] });
  expect(storage.rows("budget").map((r) => r.values.amount)).toEqual([900, 300]);
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
  expect(storage.rows("budget").map((r) => r.id)).toEqual([2]);
  expect(storage.archivedRows("budget").map((r) => r.id)).toEqual([1]);
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

test("an Archived row cannot be updated", ({ storage }) => {
  createBudget(storage);
  storage.appendRows({ store: "budget", rows: [{ month: "2026-01-01", amount: 900 }] });
  storage.archiveRow({ store: "budget", id: 1, expectedVersion: 1 });
  const failure = failureOf(() =>
    storage.updateRows({
      store: "budget",
      rows: [{ id: 1, expectedVersion: 2, values: { amount: 1 } }],
    }),
  );
  expect(failure.code).toBe("archived");
});

test("two rows of one append sharing a Key fail with conflict naming the earlier row", ({
  storage,
}) => {
  createBudget(storage);
  const row = { month: "2026-01-01", category: "rent" };
  const failure = failureOf(() => storage.appendRows({ store: "budget", rows: [row, row] }));
  expect(failure.details.current).toEqual([{ index: 1, sameKeyAsIndex: 0 }]);
});

function appendMonths(storage: Storage) {
  createBudget(storage);
  storage.appendRows({
    store: "budget",
    rows: ["2026-08-01", "2026-09-01", "2026-10-01"].map((month) => ({
      month,
      category: "rent",
      amount: 900,
    })),
  });
}

test("listing rows returns live rows newest first with ids and versions", ({ storage }) => {
  appendMonths(storage);
  storage.archiveRow({ store: "budget", id: 2, expectedVersion: 1 });
  expect(storage.listRows({ store: "budget" })).toEqual({
    rows: [3, 1].map((id) => ({
      id,
      version: 1,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      values: expect.objectContaining({ category: "rent", amount: 900 }),
    })),
    truncated: false,
  });
});

test("listing rows applies a filter with a relative date", () => {
  const storage = createStorage(":memory:", { now: () => "2026-11-10T12:00:00.000Z" });
  appendMonths(storage);
  const filter = [{ column: "month", op: ">=" as const, value: { relative: "-10w" } }];
  const { rows } = storage.listRows({ store: "budget", filter });
  expect(rows.map((r) => r.values.month)).toEqual(["2026-10-01", "2026-09-01"]);
  storage.close();
});

test("listing rows applies an equality filter", ({ storage }) => {
  appendMonths(storage);
  const filter = [{ column: "month", op: "=" as const, value: "2026-09-01" }];
  expect(storage.listRows({ store: "budget", filter }).rows.map((r) => r.id)).toEqual([2]);
});

test("listing rows stops at the limit and reports truncated", ({ storage }) => {
  appendMonths(storage);
  const result = storage.listRows({ store: "budget", limit: 2 });
  expect(result.rows.map((r) => r.id)).toEqual([3, 2]);
  expect(result.truncated).toBe(true);
  expect(storage.listRows({ store: "budget", limit: 3 }).truncated).toBe(false);
});

test("a filter on an unknown column fails with invalid at its path", ({ storage }) => {
  createBudget(storage);
  const filter = [{ column: "colour", op: "empty" as const }];
  const failure = failureOf(() => storage.listRows({ store: "budget", filter }));
  expect(failure.code).toBe("invalid");
  expect(failure.details.issues?.[0]?.path).toEqual(["filter", 0, "column"]);
});

test("listing the rows of an Archived Data Store fails with archived", ({ storage }) => {
  createBudget(storage);
  const { id } = storage.archiveStore({ id: "budget", expectedVersion: 1 });
  expect(failureOf(() => storage.listRows({ store: id })).code).toBe("archived");
});
