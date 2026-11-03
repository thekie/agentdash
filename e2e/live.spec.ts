import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { test as base, expect, type Page } from "@playwright/test";
import { createStorage } from "../src/storage/storage.ts";

async function startServer(dataDir: string, port = 0) {
  const child = spawn("node", ["src/main.ts", "--port", String(port), "--data-dir", dataDir]);
  const [chunk] = await once(child.stdout, "data");
  const url = /running at (\S+)/.exec(String(chunk))?.[1];
  if (!url) throw new Error(`unexpected server output: ${chunk}`);
  return { child, url };
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function callAgentTool(url: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  expect(result.isError).toBeFalsy();
}

interface LiveServer {
  url: string;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

const test = base.extend<{ dataDir: string; server: LiveServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first argument.
  dataDir: async ({}, use) => {
    mkdirSync(".data", { recursive: true });
    const dataDir = mkdtempSync(join(".data", "e2e-live-"));
    await use(dataDir);
    rmSync(dataDir, { recursive: true });
  },
  server: async ({ dataDir }, use) => {
    let running = await startServer(dataDir);
    const { url } = running;
    await use({
      url,
      stop: () => stopServer(running.child),
      restart: async () => {
        running = await startServer(dataDir, Number(new URL(url).port));
      },
    });
    await stopServer(running.child);
  },
});

const sidebarLinks = (page: Page) =>
  page.getByRole("navigation", { name: "Dashboards" }).getByRole("link");

async function openFinance(page: Page, url: string) {
  await callAgentTool(url, "dashboard_create", { title: "Finance" });
  await page.goto(`${url}/finance`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("📄Finance");
}

for (const path of ["/", "/somewhere"]) {
  test(`the empty state at ${path} opens the first Area once an Agent creates it`, async ({
    page,
    server: { url },
  }) => {
    await page.goto(`${url}${path}`);
    await expect(page.getByRole("status")).toContainText("This page fills in by itself");
    await callAgentTool(url, "dashboard_create", { title: "Finance", icon: "💶" });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("💶Finance");
    await expect(page).toHaveURL(`${url}/finance`);
  });
}

test("the empty state replaces the listening status once the server stops", async ({
  page,
  server,
}) => {
  await page.goto(server.url);
  await expect(page.getByRole("status")).toContainText("Listening on");
  await server.stop();
  await expect(page.getByRole("status")).toContainText("Reconnecting…");
});

test("the open Dashboard follows an Agent write in place", async ({ page, server: { url } }) => {
  await callAgentTool(url, "dashboard_create", { title: "Finance" });
  await callAgentTool(url, "store_create", {
    name: "spending",
    columns: [{ key: "amount", type: "number" }],
  });
  await callAgentTool(url, "widget_add", {
    parent: { dashboard: "finance" },
    widget: {
      type: "kpi",
      title: "Spent",
      config: {},
      projection: {
        from: "spending",
        aggregate: [{ op: "sum", column: "amount", as: "total" }],
        slots: { y: "total" },
      },
    },
  });
  await page.goto(`${url}/finance`);
  const widget = page.getByRole("region", { name: "Spent" });
  await expect(widget).toContainText("No data yet");
  await expect(page.getByRole("status")).toHaveText("Live");
  await widget.evaluate((node) => node.setAttribute("data-same-node", ""));

  await callAgentTool(url, "rows_append", { store: "spending", rows: [{ amount: 42 }] });
  await expect(widget).toContainText("42");
  await expect(widget).toHaveAttribute("data-same-node");
});

test("the sidebar follows an Agent write", async ({ page, server: { url } }) => {
  await openFinance(page, url);
  await callAgentTool(url, "dashboard_create", { title: "Health" });
  await expect(sidebarLinks(page)).toHaveText(["📄Finance", "📄Health"]);
});

test("a lost connection reads Reconnecting and keeps the last data", async ({ page, server }) => {
  await openFinance(page, server.url);
  await server.stop();
  await expect(page.getByRole("status")).toContainText("Reconnecting…");
  await expect(page.getByRole("status")).toContainText("Showing the last data we received");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("📄Finance");
});

test("a connection that stays lost reads Server stopped", async ({ page, server }) => {
  await openFinance(page, server.url);
  await server.stop();
  await expect(page.getByRole("status")).toContainText("Server stopped", { timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText("npx agentdash");
});

test("a restarted server reads Live and the page catches up", async ({ page, dataDir, server }) => {
  await openFinance(page, server.url);
  await server.stop();
  await expect(page.getByRole("status")).toContainText("Reconnecting…");
  const storage = createStorage(join(dataDir, "agentdash.db"));
  storage.createDashboard({ title: "Health" });
  storage.close();
  await server.restart();
  await expect(page.getByRole("status")).toHaveText("Live", { timeout: 15_000 });
  await expect(sidebarLinks(page)).toHaveText(["📄Finance", "📄Health"]);
});
