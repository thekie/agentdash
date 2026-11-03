import { expect } from "vitest";
import { failureOf, test } from "./fixture.ts";
import type { Storage } from "./storage.ts";

function createWeightChart(storage: Storage) {
  const store = storage.createStore({
    name: "weight_log",
    columns: [
      { key: "day", type: "date" },
      { key: "kg", type: "number" },
    ],
  });
  const health = storage.createDashboard({ title: "Health" });
  const widget = storage.addWidget({
    parent: { dashboard: health.id },
    widget: {
      type: "chart",
      config: { mark: "line" },
      projection: {
        from: "weight_log",
        select: [{ column: "day" }, { column: "kg" }],
        slots: { x: "day", y: ["kg"] },
      },
    },
  });
  return { store, health, widget };
}

test("a Widget shows its Projection as the Agent wrote it", ({ storage }) => {
  const { health } = createWeightChart(storage);
  expect(storage.dashboard(health.id).widgets[0]?.projection).toEqual({
    from: "weight_log",
    select: [
      { column: "day", as: "day" },
      { column: "kg", as: "kg" },
    ],
    slots: { x: "day", y: ["kg"] },
  });
});

test("a renamed column shows its new key in the Widget", ({ storage }) => {
  const { store, health } = createWeightChart(storage);
  storage.alterStore({
    store: "weight_log",
    expectedVersion: store.version,
    ops: [{ op: "rename_column", column: "kg", to: "weight" }],
  });
  const [widget] = storage.dashboard(health.id).widgets;
  expect(widget?.projection).toMatchObject({
    select: [{ column: "day" }, { column: "weight", as: "kg" }],
  });
  expect(widget?.broken).toBeUndefined();
});

test("a Widget whose column is Archived is broken", ({ storage }) => {
  const { store, health } = createWeightChart(storage);
  storage.alterStore({
    store: "weight_log",
    expectedVersion: store.version,
    ops: [{ op: "archive_column", column: "kg" }],
  });
  expect(storage.dashboard(health.id).widgets[0]?.broken).toEqual({
    reason: 'column "kg" of "weight_log" is Archived',
    missingColumn: "kg",
  });
});

test("the tree counts the broken Widgets of each Dashboard", ({ storage }) => {
  const { store } = createWeightChart(storage);
  storage.archiveStore({ id: store.id, expectedVersion: store.version });
  expect(storage.tree().map((d) => d.brokenWidgetCount)).toEqual([1]);
});

test("a Widget whose Data Store is Archived is broken", ({ storage }) => {
  const { store, health } = createWeightChart(storage);
  storage.archiveStore({ id: store.id, expectedVersion: store.version });
  expect(storage.dashboard(health.id).widgets[0]?.broken).toEqual({
    reason: 'Data Store "weight_log" is Archived',
    archivedStore: "weight_log",
  });
});

test("an invalid Projection anywhere in a Widget subtree rejects the whole subtree", ({
  storage,
}) => {
  const { health } = createWeightChart(storage);
  const failure = failureOf(() =>
    storage.addWidget({
      parent: { dashboard: health.id },
      widget: {
        type: "columns",
        config: {},
        children: [
          {
            type: "kpi",
            config: {},
            projection: { from: "weight_log", select: [{ column: "fat" }] },
          },
        ],
      },
    }),
  );
  expect(failure.code).toBe("invalid");
  expect(failure.details.issues).toMatchObject([
    { path: ["widget", "children", 0, "projection", "select", 0, "column"] },
  ]);
  expect(storage.dashboard(health.id).widgets).toHaveLength(1);
});

test("updating a Widget checks its Projection", ({ storage }) => {
  const { widget } = createWeightChart(storage);
  const failure = failureOf(() =>
    storage.updateWidget({
      id: widget.id,
      expectedVersion: 1,
      config: {},
      projection: { from: "nowhere" },
    }),
  );
  expect(failure.details.issues).toMatchObject([{ path: ["projection", "from"] }]);
});

test("a Data Store lists the live Widgets that read it", ({ storage }) => {
  const { widget } = createWeightChart(storage);
  storage.createStore({ name: "unread", columns: [{ key: "x", type: "text" }] });
  expect(storage.stores().map((s) => [s.name, s.readers])).toEqual([
    ["unread", []],
    ["weight_log", [widget.id]],
  ]);
  storage.archiveWidget({ id: widget.id, expectedVersion: 1 });
  expect(storage.store("weight_log").readers).toEqual([]);
});

test("a Widget reads back its full Projection with current enum labels", ({ storage }) => {
  const budget = storage.createStore({
    name: "budget",
    columns: [
      { key: "month", type: "date" },
      { key: "category", type: "enum", options: [{ label: "rent" }, { label: "food" }] },
      { key: "amount", type: "money", currency: "EUR" },
    ],
  });
  storage.createStore({
    name: "limits",
    columns: [
      { key: "category", type: "enum", options: [{ label: "rent" }] },
      { key: "cap", type: "money", currency: "EUR" },
    ],
  });
  const area = storage.createDashboard({ title: "Finance" });
  const projection = {
    from: "budget",
    join: [{ store: "limits", type: "left", on: { left: "category", right: "category" } }],
    filter: [
      { column: "category", op: "in", values: ["rent"] },
      { column: "month", op: ">=", value: { relative: "-1y" } },
      { column: "amount", op: "notEmpty" },
    ],
    groupBy: [{ column: "month", bucket: "quarter", as: "quarter" }],
    aggregate: [
      { op: "last", column: "limits.cap", by: "month", as: "cap" },
      { op: "sum", column: "amount", as: "spent" },
    ],
    sort: [{ column: "quarter", desc: true }],
    limit: 8,
    slots: { x: "quarter", y: ["spent"] },
  } as const;
  storage.addWidget({
    parent: { dashboard: area.id },
    widget: { type: "chart", config: {}, projection: structuredClone(projection) },
  });
  storage.alterStore({
    store: "budget",
    expectedVersion: budget.version,
    ops: [
      {
        op: "set_enum_options",
        column: "category",
        options: [{ id: "o1", label: "housing" }, { label: "food" }],
      },
    ],
  });
  const [widget] = storage.dashboard(area.id).widgets;
  expect(widget?.projection).toEqual({
    ...projection,
    filter: [{ ...projection.filter[0], values: ["housing"] }, ...projection.filter.slice(1)],
  });
  expect(widget?.broken).toBeUndefined();
});

test("a Projection of the wrong shape fails with the path inside the Widget", ({ storage }) => {
  const area = storage.createDashboard({ title: "Health" });
  const failure = failureOf(() =>
    storage.addWidget({
      parent: { dashboard: area.id },
      widget: { type: "kpi", config: {}, projection: { from: "x", limit: 0 } },
    }),
  );
  expect(failure.details.issues).toMatchObject([{ path: ["widget", "projection", "limit"] }]);
});

test("a Widget whose from Data Store is Archived still shows the current keys", ({ storage }) => {
  const { store, health } = createWeightChart(storage);
  storage.archiveStore({ id: store.id, expectedVersion: store.version });
  expect(storage.dashboard(health.id).widgets[0]?.projection).toMatchObject({
    from: "weight_log",
    select: [{ column: "day" }, { column: "kg" }],
  });
});

test("a Widget without select is broken when a Slot names an Archived column", ({ storage }) => {
  storage.createStore({
    name: "steps",
    columns: [
      { key: "day", type: "date" },
      { key: "n", type: "number" },
    ],
  });
  const area = storage.createDashboard({ title: "Health" });
  storage.addWidget({
    parent: { dashboard: area.id },
    widget: { type: "table", config: {}, projection: { from: "steps", slots: { y: "n" } } },
  });
  const steps = storage.store("steps");
  storage.alterStore({
    store: "steps",
    expectedVersion: steps.version,
    ops: [{ op: "archive_column", column: "n" }],
  });
  expect(storage.dashboard(area.id).widgets[0]?.broken).toEqual({
    reason: 'unknown output column "n"',
  });
});
