import { expect } from "vitest";
import { test } from "./storage/fixture.ts";
import type { Storage } from "./storage/storage.ts";
import { createWebApi } from "./web-api.ts";

function seedFinance(storage: Storage) {
  const finance = storage.createDashboard({ title: "Finance", icon: "💶" });
  storage.createDashboard({ parent: "finance", title: "Budget" });
  storage.createDashboard({ title: "Health" });
  const store = storage.createStore({
    name: "spending",
    columns: [{ key: "amount", type: "number", unit: "€" }],
  });
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
      ],
    },
  });
  return { finance, store };
}

test("the tree lists every live Dashboard depth first", async ({ storage }) => {
  seedFinance(storage);
  const response = await createWebApi(storage).request("/tree");
  const tree: { path: string }[] = await response.json();
  expect(tree.map((d) => d.path)).toEqual(["finance", "finance/budget", "health"]);
});

test("a Dashboard carries the rows of each Widget's Projection, nested ones too", async ({
  storage,
}) => {
  seedFinance(storage);
  const response = await createWebApi(storage).request("/dashboards/finance/budget");
  const dashboard = await response.json();
  expect(dashboard.title).toBe("Budget");
  expect(dashboard.widgets[0].children[0].result.rows).toEqual([{ total: 42 }]);
});

test("a broken Widget carries no rows", async ({ storage }) => {
  const { store } = seedFinance(storage);
  storage.archiveStore({ id: store.id, expectedVersion: store.version });
  const response = await createWebApi(storage).request("/dashboards/finance/budget");
  const [kpi] = (await response.json()).widgets[0].children;
  expect(kpi.broken).toBeDefined();
  expect(kpi).not.toHaveProperty("result");
});

test.for(["/dashboards/missing", "/dashboards/finance/budget", "/unknown"])(
  "GET %s answers 404 when there is no live Dashboard or route",
  async (path, { storage }) => {
    const { finance } = seedFinance(storage);
    storage.archiveDashboard({ id: finance.id, expectedVersion: finance.version });
    expect((await createWebApi(storage).request(path)).status).toBe(404);
  },
);
