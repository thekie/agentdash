import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createStorage } from "../src/storage/storage.ts";

const [dataDir] = process.argv.slice(2);
if (!dataDir) throw new Error("usage: node e2e/seed.ts <data-dir>");
mkdirSync(dataDir, { recursive: true });
const storage = createStorage(join(dataDir, "agentdash.db"));

storage.createDashboard({ title: "Finance", icon: "💶", description: "Money in and out" });
storage.createDashboard({ parent: "finance", title: "Budget", icon: "🧾" });
storage.createDashboard({ parent: "finance/budget", title: "Groceries", icon: "🥦" });
storage.createDashboard({ parent: "finance", title: "Savings", icon: "🏦" });
storage.createDashboard({ title: "Health", icon: "🫀" });
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
          slots: { value: "total" },
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
storage.close();
