// PROTOTYPE (How does a chart tell apart more than four series?): Finance charts with 5 to 8 series.
// biome-ignore-all lint: throwaway prototype seed

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createStorage } from "../src/storage/storage.ts";

const [dataDir] = process.argv.slice(2);
if (!dataDir) throw new Error("usage: node e2e/prototype-many-series-seed.ts <data-dir>");
mkdirSync(dataDir, { recursive: true });
const storage = createStorage(join(dataDir, "agentdash.db"));
const months = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"];
const eur = (key: string) => ({ key, type: "money", currency: "EUR" }) as const;
const store = (name: string, columns: object[], rows: object[]) => {
  storage.createStore({ name, columns } as never);
  storage.appendRows({ store: name, rows } as never);
};
const add = (widget: object) =>
  storage.addWidget({ parent: { dashboard: "finance" }, widget } as never);
const wobble = (i: number, k: number) => ((i * 7 + k * 3) % 5) - 2;

storage.createDashboard({ title: "Finance", icon: "💶" });

const categories = (names: [string, number][]) =>
  months.flatMap((month, i) =>
    names.map(([category, base], k) => ({
      month,
      category,
      amount: base + wobble(i, k) * base * 0.06,
    })),
  );
const spendColumns = [
  { key: "month", type: "date" },
  { key: "category", type: "text" },
  eur("amount"),
];
store(
  "spend",
  spendColumns,
  categories([
    ["Groceries", 420],
    ["Rent", 1200],
    ["Leisure", 180],
    ["Transport", 140],
    ["Utilities", 210],
  ]),
);
store(
  "spend_detail",
  spendColumns,
  categories([
    ["Groceries", 420],
    ["Rent", 1200],
    ["Leisure", 180],
    ["Transport", 140],
    ["Utilities", 210],
    ["Insurance", 95],
    ["Subscriptions", 48],
    ["Gifts", 60],
  ]),
);
const accounts = ["Checking", "Savings", "Brokerage", "Pension", "Crypto", "Cash"];
store(
  "accounts",
  [{ key: "month", type: "date" }, ...accounts.map(eur)],
  months.map((month, i) => ({
    month,
    Checking: 2400 + wobble(i, 1) * 200,
    Savings: 14200 + i * 600,
    Brokerage: 9100 + i * 450,
    Pension: 21000 + i * 300,
    Crypto: 1800 + wobble(i, 2) * 300,
    Cash: 300 + wobble(i, 3) * 40,
  })),
);
const etfs = ["VWCE", "EUNL", "IS3N", "XDWD", "SXR8", "EXSA"];
store(
  "prices",
  [{ key: "month", type: "date" }, ...etfs.map(eur)],
  months.map((month, i) =>
    Object.fromEntries([
      ["month", month],
      ...etfs.map((e, k) => [e, 40 + k * 22 + i * (1 + k * 0.4) + wobble(i, k) * 1.5]),
    ]),
  ),
);
const sources = ["Salary", "Freelance", "Dividends", "Interest", "Rental"];
store(
  "income",
  [{ key: "month", type: "date" }, ...sources.map(eur)],
  months.map((month, i) => ({
    month,
    Salary: 3800,
    Freelance: 900 + wobble(i, 1) * 250,
    Dividends: 120 + (i % 3) * 90,
    Interest: 45 + i * 3,
    Rental: 650,
  })),
);

add({
  type: "chart",
  title: "Spending by category",
  config: { mark: "bar", stacked: true },
  projection: { from: "spend", slots: { x: "month", y: "amount", series: "category" } },
});
add({
  type: "chart",
  title: "Spending, all categories",
  config: { mark: "bar", stacked: true },
  projection: { from: "spend_detail", slots: { x: "month", y: "amount", series: "category" } },
});
add({
  type: "chart",
  title: "Account balances",
  config: { mark: "line", additive: true },
  projection: { from: "accounts", slots: { x: "month", y: accounts } },
});
add({
  type: "chart",
  title: "ETF prices",
  config: { mark: "line" },
  projection: { from: "prices", slots: { x: "month", y: etfs } },
});
add({
  type: "chart",
  title: "Income by source",
  config: { mark: "bar", additive: true },
  projection: { from: "income", slots: { x: "month", y: sources } },
});
storage.close();
