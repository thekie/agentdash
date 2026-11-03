import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createStorage } from "../src/storage/storage.ts";

const [dataDir] = process.argv.slice(2);
if (!dataDir) throw new Error("usage: node e2e/seed.ts <data-dir>");
mkdirSync(dataDir, { recursive: true });
const storage = createStorage(join(dataDir, "agentdash.db"));

/** Returns the date `days` from today as `YYYY-MM-DD`. */
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

storage.createDashboard({ title: "Finance", icon: "💶", description: "Money in and out" });
const budget = storage.createDashboard({ parent: "finance", title: "Budget", icon: "🧾" });
storage.createDashboard({ parent: "finance/budget", title: "Groceries", icon: "🥦" });
const savings = storage.createDashboard({
  parent: "finance",
  title: "Savings",
  icon: "🏦",
  description: "Funds and holdings",
});
storage.createDashboard({ title: "Health", icon: "🫀" });

storage.addWidget({
  parent: { dashboard: "finance" },
  widget: {
    type: "columns",
    config: {},
    children: [
      { type: "dashboardLink", config: { dashboardId: budget.id } },
      { type: "dashboardLink", config: { dashboardId: savings.id } },
    ],
  },
});

storage.createStore({ name: "spending", columns: [{ key: "amount", type: "number", unit: "€" }] });
storage.appendRows({ store: "spending", rows: [{ amount: 40 }, { amount: 2 }] });
storage.addWidget({
  parent: { dashboard: "finance/budget" },
  widget: {
    type: "section",
    title: "This month",
    config: {},
    children: [
      {
        type: "kpi",
        title: "Spent",
        config: {},
        projection: {
          from: "spending",
          aggregate: [{ op: "sum", column: "amount", as: "total" }],
          slots: { y: "total" },
        },
      },
      {
        type: "columns",
        config: {},
        children: [
          { type: "note", title: "Tip", config: { markdown: "Cook at home." } },
          { type: "note", title: "Reminder", config: { markdown: "Check the bills." } },
        ],
      },
    ],
  },
});

storage.createStore({
  name: "balance",
  columns: [
    { key: "month", type: "date" },
    { key: "amount", type: "money", currency: "EUR" },
  ],
});
storage.appendRows({
  store: "balance",
  rows: [
    { month: "2026-07-01", amount: 18200 },
    { month: "2026-08-01", amount: 19400 },
    { month: "2026-09-01", amount: 20300 },
    { month: "2026-10-01", amount: 21050 },
  ],
});
storage.createStore({
  name: "categories",
  columns: [
    { key: "name", type: "text" },
    { key: "spent", type: "money", currency: "EUR" },
    { key: "limit", type: "money", currency: "EUR" },
  ],
});
storage.appendRows({
  store: "categories",
  rows: [
    { name: "Groceries", spent: 380, limit: 400 },
    { name: "Leisure", spent: 270, limit: 200 },
  ],
});
storage.addWidget({
  parent: { dashboard: "finance/savings" },
  widget: {
    type: "columns",
    config: {},
    children: [
      {
        type: "kpi",
        title: "Balance",
        config: {},
        projection: {
          from: "balance",
          sort: [{ column: "month" }],
          slots: { x: "month", y: "amount" },
        },
      },
      {
        type: "progress",
        title: "Emergency fund",
        config: { target: 30000 },
        projection: {
          from: "balance",
          aggregate: [{ op: "last", column: "amount", by: "month", as: "saved" }],
          slots: { value: "saved" },
        },
      },
    ],
  },
});
storage.addWidget({
  parent: { dashboard: "finance/savings" },
  widget: {
    type: "progress",
    title: "Category limits",
    config: { goodDirection: "down" },
    projection: { from: "categories", slots: { label: "name", value: "spent", target: "limit" } },
  },
});
storage.addWidget({
  parent: { dashboard: "finance/savings" },
  widget: { type: "table", title: "Categories", config: {}, projection: { from: "categories" } },
});

storage.createStore({
  name: "weight",
  columns: [
    { key: "date", type: "date" },
    { key: "kg", type: "number", unit: "kg" },
  ],
});
storage.appendRows({
  store: "weight",
  rows: [
    { date: "2026-10-04", kg: 83.9 },
    { date: "2026-10-11", kg: 83.2 },
    { date: "2026-10-18", kg: 82.9 },
  ],
});
storage.createStore({
  name: "activity",
  columns: [
    { key: "week", type: "text" },
    { key: "sport", type: "text" },
    { key: "minutes", type: "number", unit: "min" },
  ],
});
storage.appendRows({
  store: "activity",
  rows: [
    { week: "W41", sport: "Run", minutes: 90 },
    { week: "W41", sport: "Ride", minutes: 120 },
    { week: "W42", sport: "Run", minutes: 75 },
    { week: "W42", sport: "Ride", minutes: 60 },
  ],
});
storage.createStore({
  name: "distance",
  columns: [
    { key: "week", type: "text" },
    { key: "run", type: "number", unit: "km" },
    { key: "ride", type: "number", unit: "km" },
  ],
});
storage.appendRows({
  store: "distance",
  rows: [
    { week: "W41", run: 18, ride: 30 },
    { week: "W42", run: 22, ride: 12 },
  ],
});
storage.createStore({
  name: "habits",
  columns: [
    { key: "habit", type: "text" },
    { key: "done", type: "boolean" },
  ],
});
storage.appendRows({
  store: "habits",
  rows: [
    { habit: "Stretch", done: true },
    { habit: "Walk", done: false },
  ],
});
for (const widget of [
  {
    type: "chart",
    title: "Weight",
    config: { mark: "line" },
    projection: { from: "weight", slots: { x: "date", y: "kg" } },
  },
  {
    type: "chart",
    title: "Minutes per week",
    config: { mark: "bar", stacked: true },
    projection: { from: "activity", slots: { x: "week", y: "minutes", series: "sport" } },
  },
  {
    type: "chart",
    title: "Distance per week",
    config: { mark: "bar" },
    projection: { from: "distance", slots: { x: "week", y: ["run", "ride"] } },
  },
  {
    type: "checklist",
    title: "This week",
    config: {
      items: [
        { text: "Book check-up", done: false, due: day(-3) },
        { text: "Buy shoes", done: true },
        { text: "Plan meals", done: false, due: day(5) },
      ],
    },
  },
  {
    type: "checklist",
    title: "Habits",
    config: { done: "hide" },
    projection: { from: "habits", slots: { label: "habit", done: "done" } },
  },
  {
    type: "note",
    title: "Tips",
    config: {
      markdown:
        "Drink **water** with `every` meal.\n\n- Sleep 8h\n- ~~Skip~~ breakfast\n\nRead [the guide](https://example.com).\n\n<b>raw</b>",
    },
  },
]) {
  storage.addWidget({ parent: { dashboard: "health" }, widget });
}

storage.createStore({ name: "receipts", columns: [{ key: "amount", type: "number" }] });
storage.createStore({
  name: "runs",
  columns: [
    { key: "date", type: "date" },
    { key: "km", type: "number" },
  ],
});
storage.appendRows({ store: "runs", rows: [{ date: "2026-10-01", km: 5 }] });
const holdings = storage.createStore({
  name: "holdings",
  columns: [{ key: "value", type: "number" }],
});
for (const widget of [
  {
    type: "kpi",
    title: "Receipts",
    config: {},
    projection: {
      from: "receipts",
      aggregate: [{ op: "sum", column: "amount", as: "total" }],
      slots: { y: "total" },
    },
  },
  {
    type: "table",
    title: "Receipt list",
    config: {},
    projection: { from: "receipts" },
  },
  {
    type: "chart",
    title: "Weekly km",
    config: { mark: "line" },
    projection: { from: "runs", slots: { x: "date", y: "km" } },
  },
  {
    type: "table",
    title: "Holdings",
    config: {},
    projection: { from: "holdings" },
  },
]) {
  storage.addWidget({ parent: { dashboard: "finance/budget/groceries" }, widget });
}
const runs = storage.store("runs");
storage.alterStore({
  store: "runs",
  expectedVersion: runs.version,
  ops: [{ op: "archive_column", column: "km" }],
});
storage.archiveStore({ id: holdings.id, expectedVersion: holdings.version });
storage.close();
