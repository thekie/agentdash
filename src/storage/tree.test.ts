import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { failureOf, test } from "./fixture.ts";
import { createStorage } from "./storage.ts";

test("an Area gets its slug and path from the title", ({ storage }) => {
  const area = storage.createDashboard({ title: "Café Finances" });
  expect(area).toMatchObject({
    parentId: null,
    slug: "cafe-finances",
    path: "cafe-finances",
    version: 1,
  });
});

test("a nested Dashboard is found by its path", ({ storage }) => {
  const finance = storage.createDashboard({ title: "Finance" });
  const budget = storage.createDashboard({ parent: finance.id, title: "Budget", slug: "monthly" });
  expect(storage.dashboard("finance/monthly")).toMatchObject({
    id: budget.id,
    path: "finance/monthly",
  });
});

test("an unknown path is not_found", ({ storage }) => {
  expect(failureOf(() => storage.dashboard("nowhere")).code).toBe("not_found");
});

test("creating a Dashboard whose slug a sibling has fails with conflict and returns the sibling", ({
  storage,
}) => {
  const health = storage.createDashboard({ title: "Health" });
  const failure = failureOf(() => storage.createDashboard({ title: "health" }));
  expect(failure.code).toBe("conflict");
  expect(failure.details.current).toMatchObject({ id: health.id, path: "health" });
});

test("a slug that is not lowercase words is invalid", ({ storage }) => {
  expect(failureOf(() => storage.createDashboard({ title: "X", slug: "Big Money" })).code).toBe(
    "invalid",
  );
});

test("a new title keeps the slug and bumps the version", ({ storage }) => {
  const area = storage.createDashboard({ title: "Health" });
  const renamed = storage.updateDashboard({
    id: area.id,
    expectedVersion: 1,
    title: "Wellbeing",
    icon: "🌿",
  });
  expect(renamed).toMatchObject({ title: "Wellbeing", slug: "health", icon: "🌿", version: 2 });
});

test("a stale expectedVersion fails with conflict and returns the current state", ({ storage }) => {
  const area = storage.createDashboard({ title: "Health" });
  storage.updateDashboard({ id: area.id, expectedVersion: 1, title: "Body" });
  const failure = failureOf(() =>
    storage.updateDashboard({ id: area.id, expectedVersion: 1, title: "Mind" }),
  );
  expect(failure.code).toBe("conflict");
  expect(failure.details.current).toMatchObject({ title: "Body", version: 2 });
});

test("position anchors order sibling Dashboards", ({ storage }) => {
  const b = storage.createDashboard({ title: "B" });
  storage.createDashboard({ title: "D" });
  storage.createDashboard({ title: "A", position: "first" });
  storage.createDashboard({ title: "C", position: { after: b.id } });
  expect(storage.tree().map((d) => d.path)).toEqual(["a", "b", "c", "d"]);
});

test("an anchor that is not a sibling is invalid", ({ storage }) => {
  const failure = failureOf(() =>
    storage.createDashboard({ title: "A", position: { before: "d_nope" } }),
  );
  expect(failure.code).toBe("invalid");
});

test("the tree lists every live Dashboard depth first with Widget and child counts", ({
  storage,
}) => {
  const finance = storage.createDashboard({ title: "Finance" });
  storage.createDashboard({ parent: finance.id, title: "Budget" });
  storage.createDashboard({ title: "Health" });
  storage.addWidget({
    parent: { dashboard: finance.id },
    widget: {
      type: "section",
      title: "Top",
      config: {},
      children: [{ type: "note", config: { markdown: "hi" } }],
    },
  });
  expect(storage.tree()).toMatchObject([
    { path: "finance", widgetCount: 2, childCount: 1 },
    { path: "finance/budget", widgetCount: 0, childCount: 0 },
    { path: "health", widgetCount: 0, childCount: 0 },
  ]);
});

test("moving a Dashboard changes its path", ({ storage }) => {
  const finance = storage.createDashboard({ title: "Finance" });
  const budget = storage.createDashboard({ title: "Budget" });
  const moved = storage.moveDashboard({ id: budget.id, expectedVersion: 1, parent: "finance" });
  expect(moved).toMatchObject({ parentId: finance.id, path: "finance/budget", version: 2 });
});

test("a Dashboard cannot move under its own child", ({ storage }) => {
  const finance = storage.createDashboard({ title: "Finance" });
  const budget = storage.createDashboard({ parent: finance.id, title: "Budget" });
  const failure = failureOf(() =>
    storage.moveDashboard({ id: finance.id, expectedVersion: 1, parent: budget.id }),
  );
  expect(failure.code).toBe("invalid");
});

test("Archiving a Dashboard hides its whole subtree, and only it is listed as Archived", ({
  storage,
}) => {
  const finance = storage.createDashboard({ title: "Finance" });
  storage.createDashboard({ parent: finance.id, title: "Budget" });
  storage.createDashboard({ title: "Health" });
  storage.archiveDashboard({ id: finance.id, expectedVersion: 1 });
  expect(storage.tree().map((d) => d.path)).toEqual(["health"]);
  expect(storage.archived().dashboards.map((d) => d.id)).toEqual([finance.id]);
});

test("restoring a Dashboard brings its subtree back", ({ storage }) => {
  const finance = storage.createDashboard({ title: "Finance" });
  storage.createDashboard({ parent: finance.id, title: "Budget" });
  storage.archiveDashboard({ id: finance.id, expectedVersion: 1 });
  storage.restoreDashboard({ id: finance.id, expectedVersion: 2 });
  expect(storage.tree().map((d) => d.path)).toEqual(["finance", "finance/budget"]);
});

test("Archiving twice changes nothing", ({ storage }) => {
  const area = storage.createDashboard({ title: "Finance" });
  const archived = storage.archiveDashboard({ id: area.id, expectedVersion: 1 });
  expect(storage.archiveDashboard({ id: area.id, expectedVersion: 2 })).toEqual(archived);
});

test("restoring a Dashboard whose slug a live sibling took fails with conflict", ({ storage }) => {
  const old = storage.createDashboard({ title: "Finance" });
  storage.archiveDashboard({ id: old.id, expectedVersion: 1 });
  storage.createDashboard({ title: "Finance" });
  expect(failureOf(() => storage.restoreDashboard({ id: old.id, expectedVersion: 2 })).code).toBe(
    "conflict",
  );
});

test("a write under an Archived Dashboard fails with archived, naming it", ({ storage }) => {
  const finance = storage.createDashboard({ title: "Finance" });
  const budget = storage.createDashboard({ parent: finance.id, title: "Budget" });
  storage.archiveDashboard({ id: finance.id, expectedVersion: 1 });
  const failure = failureOf(() => storage.createDashboard({ parent: budget.id, title: "Rent" }));
  expect(failure.code).toBe("archived");
  expect(failure.message).toContain(finance.id);
});

test("a Widget subtree is added in order and read back nested", ({ storage }) => {
  const area = storage.createDashboard({ title: "Health" });
  storage.addWidget({
    parent: { dashboard: area.id },
    widget: {
      type: "columns",
      config: {},
      children: [
        { type: "kpi", title: "Weight", config: {}, projection: { from: "weight" } },
        { type: "note", config: { markdown: "Drink water" } },
      ],
    },
  });
  const [columns] = storage.dashboard("health").widgets;
  expect(columns?.children.map((w) => [w.type, w.title, w.projection])).toEqual([
    ["kpi", "Weight", { from: "weight" }],
    ["note", null, null],
  ]);
});

test("adding a Widget leaves the Dashboard's version alone", ({ storage }) => {
  const area = storage.createDashboard({ title: "Health" });
  storage.addWidget({ parent: { dashboard: area.id }, widget: { type: "note", config: {} } });
  expect(storage.dashboard(area.id).version).toBe(1);
});

test("updating a Widget replaces its own fields and keeps its children", ({ storage }) => {
  const area = storage.createDashboard({ title: "Health" });
  const section = storage.addWidget({
    parent: { dashboard: area.id },
    widget: {
      type: "section",
      title: "Old",
      config: { a: 1 },
      children: [{ type: "note", config: {} }],
    },
  });
  const updated = storage.updateWidget({
    id: section.id,
    expectedVersion: 1,
    title: "New",
    config: {},
  });
  expect(updated).toMatchObject({
    title: "New",
    config: {},
    version: 2,
    children: [{ type: "note" }],
  });
});

test("a Widget moves with its subtree to another Dashboard", ({ storage }) => {
  const from = storage.createDashboard({ title: "From" });
  const to = storage.createDashboard({ title: "To" });
  const section = storage.addWidget({
    parent: { dashboard: from.id },
    widget: { type: "section", title: "S", config: {}, children: [{ type: "note", config: {} }] },
  });
  storage.moveWidget({ id: section.id, expectedVersion: 1, parent: { dashboard: "to" } });
  expect(storage.dashboard(from.id).widgets).toEqual([]);
  expect(storage.dashboard(to.id).widgets).toMatchObject([
    { id: section.id, children: [{ type: "note" }] },
  ]);
});

test("a Widget cannot move into its own child", ({ storage }) => {
  const area = storage.createDashboard({ title: "Health" });
  const outer = storage.addWidget({
    parent: { dashboard: area.id },
    widget: {
      type: "section",
      title: "S",
      config: {},
      children: [{ type: "columns", config: {} }],
    },
  });
  const inner = outer.children[0]?.id ?? "";
  const failure = failureOf(() =>
    storage.moveWidget({ id: outer.id, expectedVersion: 1, parent: { widget: inner } }),
  );
  expect(failure.code).toBe("invalid");
});

test("an Archived Widget is hidden until restored", ({ storage }) => {
  const area = storage.createDashboard({ title: "Health" });
  const note = storage.addWidget({
    parent: { dashboard: area.id },
    widget: { type: "note", config: {} },
  });
  storage.archiveWidget({ id: note.id, expectedVersion: 1 });
  expect(storage.dashboard(area.id).widgets).toEqual([]);
  storage.restoreWidget({ id: note.id, expectedVersion: 2 });
  expect(storage.dashboard(area.id).widgets.map((w) => w.id)).toEqual([note.id]);
});

test("a Widget cannot be restored while its Dashboard is Archived", ({ storage }) => {
  const area = storage.createDashboard({ title: "Health" });
  const note = storage.addWidget({
    parent: { dashboard: area.id },
    widget: { type: "note", config: {} },
  });
  storage.archiveWidget({ id: note.id, expectedVersion: 1 });
  storage.archiveDashboard({ id: area.id, expectedVersion: 1 });
  expect(failureOf(() => storage.restoreWidget({ id: note.id, expectedVersion: 2 })).code).toBe(
    "archived",
  );
});

test("data survives reopening the database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentdash-db-"));
  const file = join(dir, "agentdash.db");
  const first = createStorage(file);
  first.createDashboard({ title: "Finance" });
  first.close();
  const second = createStorage(file);
  expect(second.tree().map((d) => d.path)).toEqual(["finance"]);
  second.close();
  rmSync(dir, { recursive: true });
});

test("reading an Archived Dashboard by id fails with archived", ({ storage }) => {
  const area = storage.createDashboard({ title: "Finance" });
  const budget = storage.createDashboard({ parent: area.id, title: "Budget" });
  storage.archiveDashboard({ id: area.id, expectedVersion: 1 });
  expect(failureOf(() => storage.dashboard(budget.id)).code).toBe("archived");
});

test("a restored Dashboard comes back as the last of its siblings", ({ storage }) => {
  const a = storage.createDashboard({ title: "A" });
  storage.createDashboard({ title: "B" });
  storage.archiveDashboard({ id: a.id, expectedVersion: 1 });
  storage.createDashboard({ title: "C", position: "first" });
  storage.restoreDashboard({ id: a.id, expectedVersion: 2 });
  expect(storage.tree().map((d) => d.path)).toEqual(["c", "b", "a"]);
});
