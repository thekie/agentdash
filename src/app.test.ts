import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { test as base, expect } from "vitest";
import { createApp, serverInfo } from "./app.ts";
import { createStorage } from "./storage/storage.ts";

const test = base.extend<{ app: ReturnType<typeof createApp>["app"] }>({
  // biome-ignore lint/correctness/noEmptyPattern: A Vitest fixture must destructure its first argument.
  app: async ({}, use) => {
    const webRoot = mkdtempSync(join(tmpdir(), "agentdash-web-"));
    writeFileSync(join(webRoot, "index.html"), "<h1>agentdash</h1>");
    const storage = createStorage(":memory:");
    const { app, close } = createApp(webRoot, storage);
    await use(app);
    await close();
    storage.close();
    rmSync(webRoot, { recursive: true });
  },
});

test.for([
  ["legacy", "legacy"],
  ["auto", "modern"],
] as const)(
  "an Agent connects over /mcp (%s negotiation, %s protocol)",
  async ([mode, era], { app }) => {
    const client = new Client({ name: "test", version: "0" }, { versionNegotiation: { mode } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://agentdash.test/mcp"), {
        fetch: async (url, init) => app.fetch(new Request(url, init)),
      }),
    );
    expect(client.getServerVersion()).toEqual(serverInfo);
    expect(client.getProtocolEra()).toBe(era);
    await client.close();
  },
);

test.for([
  ["/", 200],
  ["/finance/budget", 200],
  ["/assets/missing.js", 404],
] as const)("GET %s answers %i", async ([path, status], { app }) => {
  expect((await app.request(path)).status).toBe(status);
});
