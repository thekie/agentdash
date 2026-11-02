import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { test as base, expect } from "vitest";
import { z } from "zod";
import { serverInfo } from "./app.ts";
import { instructions } from "./instructions.ts";
import { createStorage, type Storage } from "./storage/storage.ts";
import { registerTools } from "./tools.ts";

interface Agent {
  client: Client;
  /** Calls a tool and returns its parsed JSON, with `isError` from the result. */
  call: (
    name: string,
    args?: Record<string, unknown>,
    // biome-ignore lint/suspicious/noExplicitAny: Tests read deep fields of many result shapes.
  ) => Promise<{ isError: boolean; body: any }>;
}

const ToolText = z.array(z.object({ text: z.string() }));

async function connectAgent(storage: Storage): Promise<Agent> {
  const server = new McpServer(serverInfo, { instructions });
  registerTools(server, storage);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return {
    client,
    call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const [content] = ToolText.parse(result.content);
      return { isError: result.isError === true, body: JSON.parse(content?.text ?? "null") };
    },
  };
}

const test = base.extend<{ storage: Storage; agent: Agent; other: Agent }>({
  // biome-ignore lint/correctness/noEmptyPattern: A Vitest fixture must destructure its first argument.
  storage: async ({}, use) => {
    const storage = createStorage(":memory:");
    await use(storage);
    storage.close();
  },
  agent: async ({ storage }, use) => {
    const agent = await connectAgent(storage);
    await use(agent);
    await agent.client.close();
  },
  other: async ({ storage }, use) => {
    const agent = await connectAgent(storage);
    await use(agent);
    await agent.client.close();
  },
});

async function seedFinance(agent: Agent): Promise<{ id: string }> {
  const area = await agent.call("dashboard_create", { title: "Finance" });
  await agent.call("store_create", {
    name: "expenses",
    columns: [
      { key: "date", type: "date" },
      { key: "category", type: "text" },
      { key: "amount", type: "money", currency: "EUR" },
    ],
    key: ["date", "category"],
  });
  await agent.call("rows_append", {
    store: "expenses",
    rows: [
      { date: "2026-10-01", category: "Groceries", amount: 42.1 },
      { date: "2026-10-02", category: "Rent", amount: 900 },
    ],
  });
  return area.body;
}

const chart = (y: string) => ({
  type: "chart",
  title: "Spending",
  config: { mark: "bar" },
  projection: { from: "expenses", slots: { x: "date", y } },
});

test("the server sends the primer and 16 tools with object input schemas", async ({ agent }) => {
  expect(agent.client.getInstructions()).toBe(instructions);
  const { tools } = await agent.client.listTools();
  expect(tools).toHaveLength(16);
  expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
  const widgetAdd = tools.find((t) => t.name === "widget_add");
  expect(JSON.stringify(widgetAdd?.inputSchema)).toContain('"dashboardLink"');
});

test("an Agent builds a chart from appended rows and reads it back", async ({ agent }) => {
  const area = await seedFinance(agent);
  const added = await agent.call("widget_add", {
    parent: { dashboard: "finance" },
    widget: chart("amount"),
  });
  expect(added.isError).toBe(false);
  const dashboard = await agent.call("get_dashboard", { dashboard: area.id });
  expect(dashboard.body.widgets).toMatchObject([
    { type: "chart", projection: { from: "expenses" } },
  ]);
  const result = await agent.call("query", {
    projection: { from: "expenses", sort: [{ column: "date" }] },
  });
  expect(result.body.rows.map((r: { amount: number }) => r.amount)).toEqual([42.1, 900]);
});

test.for([
  ["an unknown type", { type: "pie", config: {} }, ["widget", "type"]],
  [
    "a Slot on a column of the wrong type",
    chart("category"),
    ["widget", "projection", "slots", "y"],
  ],
  [
    "a missing required Slot",
    { ...chart("amount"), projection: { from: "expenses", slots: { y: "amount" } } },
    ["widget", "projection", "slots", "x"],
  ],
  [
    "an unknown Slot",
    {
      ...chart("amount"),
      projection: { from: "expenses", slots: { x: "date", y: "amount", z: "date" } },
    },
    ["widget", "projection", "slots", "z"],
  ],
  [
    "a stacked line chart",
    { ...chart("amount"), config: { mark: "line", stacked: true } },
    ["widget", "config", "stacked"],
  ],
  [
    "columns with one child",
    { type: "columns", config: {}, children: [{ type: "note", config: { markdown: "a" } }] },
    ["widget", "children"],
  ],
  [
    "a link to a missing Dashboard",
    { type: "dashboardLink", config: { dashboardId: "d_missing" } },
    ["widget", "config", "dashboardId"],
  ],
  [
    "a progress Widget without a target",
    { type: "progress", config: {}, projection: { from: "expenses", slots: { value: "amount" } } },
    ["widget", "config", "target"],
  ],
  [
    "an unknown column in a nested Projection",
    {
      type: "section",
      title: "S",
      config: {},
      children: [
        { ...chart("amount"), projection: { from: "expenses", select: [{ column: "nope" }] } },
      ],
    },
    ["widget", "children", 0, "projection", "select", 0, "column"],
  ],
  [
    "a checklist without items or a Projection",
    { type: "checklist", config: {} },
    ["widget", "config", "items"],
  ],
  [
    "two columns in a one-column Slot",
    {
      type: "kpi",
      config: {},
      projection: {
        from: "expenses",
        groupBy: [{ column: "date" }, { column: "category" }],
        aggregate: [
          { op: "sum", column: "amount", as: "total" },
          { op: "max", column: "amount", as: "top" },
          { op: "count", as: "n" },
        ],
        slots: { y: ["total", "top"] },
      },
    },
    ["widget", "projection", "slots", "y"],
  ],
  [
    "several y columns and series",
    {
      ...chart("total"),
      projection: {
        from: "expenses",
        groupBy: [{ column: "date" }, { column: "category" }],
        aggregate: [
          { op: "sum", column: "amount", as: "total" },
          { op: "max", column: "amount", as: "top" },
          { op: "count", as: "n" },
        ],
        slots: { x: "date", y: ["total", "top"], series: "category" },
      },
    },
    ["widget", "projection", "slots", "series"],
  ],
  [
    "y columns with different units",
    {
      ...chart("total"),
      projection: {
        from: "expenses",
        groupBy: [{ column: "date" }, { column: "category" }],
        aggregate: [
          { op: "sum", column: "amount", as: "total" },
          { op: "max", column: "amount", as: "top" },
          { op: "count", as: "n" },
        ],
        slots: { x: "date", y: ["total", "n"] },
      },
    },
    ["widget", "projection", "slots", "y"],
  ],
] as const)("widget_add fails with invalid on %s", async ([, widget, path], { agent }) => {
  await seedFinance(agent);
  const result = await agent.call("widget_add", { parent: { dashboard: "finance" }, widget });
  expect(result).toMatchObject({ isError: true, body: { code: "invalid" } });
  expect(result.body.issues.map((i: { path: unknown }) => i.path)).toContainEqual(path);
});

test("an unknown Widget type lists the valid types", async ({ agent }) => {
  await seedFinance(agent);
  const result = await agent.call("widget_add", {
    parent: { dashboard: "finance" },
    widget: { type: "pie", config: {} },
  });
  expect(result.body.issues[0].validValues).toContain("dashboardLink");
});

test.for([
  ["a note", { type: "note", config: { markdown: "x" } }],
  [
    "a full columns Widget",
    {
      type: "columns",
      config: {},
      children: Array(4).fill({ type: "note", config: { markdown: "x" } }),
    },
  ],
] as const)("a Widget cannot be added into %s", async ([, parent], { agent }) => {
  await seedFinance(agent);
  const holder = await agent.call("widget_add", {
    parent: { dashboard: "finance" },
    widget: parent,
  });
  const result = await agent.call("widget_add", {
    parent: { widget: holder.body.id },
    widget: { type: "note", config: { markdown: "y" } },
  });
  expect(result.body).toMatchObject({ code: "invalid", issues: [{ path: ["parent", "widget"] }] });
});

test("a stale expectedVersion fails with conflict and the current state", async ({
  agent,
  other,
}) => {
  const area = await seedFinance(agent);
  await other.call("dashboard_update", { dashboard: area.id, expectedVersion: 1, title: "Money" });
  const result = await agent.call("dashboard_update", {
    dashboard: area.id,
    expectedVersion: 1,
    title: "Budget",
  });
  expect(result).toMatchObject({
    isError: true,
    body: { code: "conflict", current: { title: "Money", version: 2 } },
  });
});

test("a second Agent appending the same Key fails with conflict naming the row", async ({
  agent,
  other,
}) => {
  await seedFinance(agent);
  const result = await other.call("rows_append", {
    store: "expenses",
    rows: [{ date: "2026-10-01", category: "Groceries", amount: 5 }],
  });
  expect(result.body).toMatchObject({
    code: "conflict",
    current: [{ index: 0, row: { values: { amount: 42.1 } } }],
  });
});

test("a write into an Archived subtree fails with archived", async ({ agent, other }) => {
  const area = await seedFinance(agent);
  await other.call("archive", { kind: "dashboard", id: area.id, expectedVersion: 1 });
  const result = await agent.call("widget_add", {
    parent: { dashboard: area.id },
    widget: { type: "note", config: { markdown: "x" } },
  });
  expect(result.body.code).toBe("archived");
});

test("widget_update replaces the config and keeps the type", async ({ agent }) => {
  await seedFinance(agent);
  const added = await agent.call("widget_add", {
    parent: { dashboard: "finance" },
    widget: chart("amount"),
  });
  const changed = await agent.call("widget_update", {
    id: added.body.id,
    expectedVersion: 1,
    widget: { ...chart("amount"), config: { mark: "line" } },
  });
  expect(changed.body).toMatchObject({ config: { mark: "line" }, version: 2 });
  const retyped = await agent.call("widget_update", {
    id: added.body.id,
    expectedVersion: 2,
    widget: { type: "note", config: { markdown: "x" } },
  });
  expect(retyped.body).toMatchObject({
    code: "invalid",
    issues: [{ path: ["widget", "type"], validValues: ["chart"] }],
  });
});

test("a Widget moves into a section", async ({ agent }) => {
  await seedFinance(agent);
  const section = await agent.call("widget_add", {
    parent: { dashboard: "finance" },
    widget: { type: "section", title: "Notes", config: {}, children: [] },
  });
  const note = await agent.call("widget_add", {
    parent: { dashboard: "finance" },
    widget: { type: "note", config: { markdown: "x" } },
  });
  await agent.call("move", {
    kind: "widget",
    id: note.body.id,
    expectedVersion: 1,
    parent: { widget: section.body.id },
  });
  const dashboard = await agent.call("get_dashboard", { dashboard: "finance" });
  expect(dashboard.body.widgets).toMatchObject([{ type: "section", children: [{ type: "note" }] }]);
});

test.for([
  ["a Dashboard to a Widget parent", { kind: "dashboard", parent: { widget: "w_x" } }],
  ["a Widget to a path", { kind: "widget", parent: "finance" }],
] as const)("moving %s fails with invalid", async ([, input], { agent }) => {
  const area = await seedFinance(agent);
  const result = await agent.call("move", { id: area.id, expectedVersion: 1, ...input });
  expect(result.body).toMatchObject({ code: "invalid", issues: [{ path: ["parent"] }] });
});

test("an Archived row is listed and restored", async ({ agent }) => {
  await seedFinance(agent);
  await agent.call("archive", { kind: "row", store: "expenses", id: 1, expectedVersion: 1 });
  const archived = await agent.call("list_archived", { store: "expenses" });
  expect(archived.body.rows).toMatchObject([{ id: 1 }]);
  const restored = await agent.call("restore", {
    kind: "row",
    store: "expenses",
    id: 1,
    expectedVersion: 2,
  });
  expect(restored.body).toMatchObject({ id: 1, archivedAt: null });
});

test.for([
  ["a row without its Data Store", { kind: "row", id: 1 }, ["store"]],
  ["a Dashboard with a number id", { kind: "dashboard", id: 1 }, ["id"]],
] as const)("archiving %s fails with invalid", async ([, ref, path], { agent }) => {
  const result = await agent.call("archive", { ...ref, expectedVersion: 1 });
  expect(result.body).toMatchObject({ code: "invalid", issues: [{ path }] });
});

test("a Data Store is Archived and restored by id", async ({ agent }) => {
  await seedFinance(agent);
  const [store] = (await agent.call("list_stores")).body;
  await agent.call("archive", { kind: "store", id: store.id, expectedVersion: 1 });
  expect((await agent.call("list_archived")).body.stores).toMatchObject([{ name: "expenses" }]);
  await agent.call("restore", { kind: "store", id: store.id, expectedVersion: 2 });
  expect((await agent.call("list_stores")).body).toHaveLength(1);
});

test("an Archived column comes back with restore_column", async ({ agent }) => {
  await seedFinance(agent);
  await agent.call("store_alter", {
    store: "expenses",
    expectedVersion: 1,
    ops: [{ op: "add_column", column: { key: "note", type: "text" } }],
  });
  await agent.call("store_alter", {
    store: "expenses",
    expectedVersion: 2,
    ops: [{ op: "archive_column", column: "note" }],
  });
  expect((await agent.call("list_archived", { store: "expenses" })).body.columns).toMatchObject([
    { key: "note" },
  ]);
  const restored = await agent.call("store_alter", {
    store: "expenses",
    expectedVersion: 3,
    ops: [{ op: "restore_column", column: "note" }],
  });
  expect(restored.body.store.columns.map((c: { key: string }) => c.key)).toContain("note");
});

test("rows_update writes values at the expected version", async ({ agent }) => {
  await seedFinance(agent);
  const result = await agent.call("rows_update", {
    store: "expenses",
    rows: [{ id: 2, expectedVersion: 1, values: { amount: 950 } }],
  });
  expect(result.body).toMatchObject([{ id: 2, version: 2, values: { amount: 950 } }]);
});

test("an unknown Dashboard fails with not_found and no issues", async ({ agent }) => {
  const result = await agent.call("get_dashboard", { dashboard: "nowhere" });
  expect(result).toMatchObject({ isError: true, body: { code: "not_found", issues: [] } });
});

test("a checklist reads its items from a Projection", async ({ agent }) => {
  await agent.call("store_create", {
    name: "todo",
    columns: [
      { key: "task", type: "text" },
      { key: "done", type: "boolean" },
    ],
  });
  const result = await agent.call("widget_add", {
    parent: { dashboard: (await agent.call("dashboard_create", { title: "Health" })).body.id },
    widget: {
      type: "checklist",
      config: {},
      projection: { from: "todo", slots: { label: "task", done: "done" } },
    },
  });
  expect(result).toMatchObject({ isError: false, body: { type: "checklist" } });
});

test("get_tree lists the Area with its Widget count", async ({ agent }) => {
  await seedFinance(agent);
  await agent.call("widget_add", {
    parent: { dashboard: "finance" },
    widget: { type: "note", config: { markdown: "x" } },
  });
  expect((await agent.call("get_tree")).body).toMatchObject([{ path: "finance", widgetCount: 1 }]);
});
