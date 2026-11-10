// PROTOTYPE (Which chart tooltips show a total?): Finance and Health charts with several series.
// biome-ignore-all lint: throwaway prototype seed

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createStorage } from "../src/storage/storage.ts";

const [dataDir] = process.argv.slice(2);
if (!dataDir) throw new Error("usage: node e2e/prototype-tooltip-seed.ts <data-dir>");
mkdirSync(dataDir, { recursive: true });
const storage = createStorage(join(dataDir, "agentdash.db"));
const months = ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"];
const weeks = ["W38", "W39", "W40", "W41", "W42"];
const eur = (key: string) => ({ key, type: "money", currency: "EUR" }) as const;
const num = (key: string, unit: string) => ({ key, type: "number", unit }) as const;
const store = (name: string, columns: object[], rows: object[]) => {
  storage.createStore({ name, columns } as never);
  storage.appendRows({ store: name, rows } as never);
};
const add = (dashboard: string, widget: object) =>
  storage.addWidget({ parent: { dashboard }, widget } as never);

storage.createDashboard({ title: "Finance", icon: "💶" });
storage.createDashboard({ title: "Health", icon: "🫀" });

store(
  "spend",
  [{ key: "month", type: "date" }, { key: "category", type: "text" }, eur("amount")],
  months.flatMap((month, i) => [
    { month, category: "Groceries", amount: 380 + i * 12 },
    { month, category: "Rent", amount: 1200 },
    { month, category: "Leisure", amount: 210 - i * 15 },
  ]),
);
store(
  "cashflow",
  [{ key: "month", type: "date" }, eur("income"), eur("spending")],
  months.map((month, i) => ({ month, income: 4200 + (i % 2) * 300, spending: 1790 + i * 40 })),
);
store(
  "accounts",
  [{ key: "month", type: "date" }, eur("checking"), eur("savings"), eur("brokerage")],
  months.map((month, i) => ({
    month,
    checking: 2400 + i * 80,
    savings: 18200 + i * 700,
    brokerage: 9100 + i * 450,
  })),
);
store(
  "prices",
  [{ key: "month", type: "date" }, eur("VWCE"), eur("EUNL")],
  months.map((month, i) => ({ month, VWCE: 118 + i * 2.4, EUNL: 96 + i * 1.7 })),
);
store(
  "balance",
  [{ key: "month", type: "date" }, eur("amount")],
  months.map((month, i) => ({ month, amount: 18200 + i * 700 })),
);
add("finance", {
  type: "chart",
  title: "Spending by category",
  config: { mark: "bar", stacked: true },
  projection: { from: "spend", slots: { x: "month", y: "amount", series: "category" } },
});
add("finance", {
  type: "chart",
  title: "Income vs spending",
  config: { mark: "bar" },
  projection: { from: "cashflow", slots: { x: "month", y: ["income", "spending"] } },
});
add("finance", {
  type: "chart",
  title: "Accounts",
  config: { mark: "line" },
  projection: { from: "accounts", slots: { x: "month", y: ["checking", "savings", "brokerage"] } },
});
add("finance", {
  type: "chart",
  title: "ETF prices",
  config: { mark: "line" },
  projection: { from: "prices", slots: { x: "month", y: ["VWCE", "EUNL"] } },
});
add("finance", {
  type: "chart",
  title: "Savings balance",
  config: { mark: "line" },
  projection: { from: "balance", slots: { x: "month", y: "amount" } },
});

store(
  "distance",
  [{ key: "week", type: "text" }, num("run", "km"), num("ride", "km")],
  weeks.map((week, i) => ({ week, run: 18 + i * 2, ride: 30 - i * 4 })),
);
store(
  "weight",
  [{ key: "week", type: "text" }, num("Me", "kg"), num("Partner", "kg")],
  weeks.map((week, i) => ({ week, Me: 83.9 - i * 0.3, Partner: 64.2 + (i % 2) * 0.4 })),
);
store(
  "heart",
  [{ key: "week", type: "text" }, num("min", "bpm"), num("avg", "bpm"), num("max", "bpm")],
  weeks.map((week, i) => ({ week, min: 52 - (i % 2), avg: 64 + (i % 3), max: 168 + i * 2 })),
);
store(
  "sleep",
  [{ key: "week", type: "text" }, num("deep", "h"), num("light", "h"), num("REM", "h")],
  weeks.map((week, i) => ({ week, deep: 1.4 + i * 0.05, light: 4.1, REM: 1.6 - i * 0.05 })),
);
add("health", {
  type: "chart",
  title: "Distance per week",
  config: { mark: "bar" },
  projection: { from: "distance", slots: { x: "week", y: ["run", "ride"] } },
});
add("health", {
  type: "chart",
  title: "Weight",
  config: { mark: "line" },
  projection: { from: "weight", slots: { x: "week", y: ["Me", "Partner"] } },
});
add("health", {
  type: "chart",
  title: "Heart rate",
  config: { mark: "line" },
  projection: { from: "heart", slots: { x: "week", y: ["min", "avg", "max"] } },
});
add("health", {
  type: "chart",
  title: "Sleep",
  config: { mark: "bar" },
  projection: { from: "sleep", slots: { x: "week", y: ["deep", "light", "REM"] } },
});
storage.close();
