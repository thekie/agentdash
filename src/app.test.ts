import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, expect, test } from "vitest";
import { createApp, VERSION } from "./app.ts";

const { app, close } = createApp("dist/web");
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});
afterAll(close);

async function connect(mode: "legacy" | "auto") {
  const client = new Client({ name: "test", version: "0" }, { versionNegotiation: { mode } });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL("http://agentdash.test/mcp"), {
    fetch: async (url, init) => app.fetch(new Request(url, init)),
  });
  await client.connect(transport);
  return client;
}

test.each([
  ["legacy", "legacy"],
  ["auto", "modern"],
] as const)("an Agent connects over /mcp (%s negotiation, %s protocol)", async (mode, era) => {
  const client = await connect(mode);
  expect(client.getServerVersion()).toMatchObject({ name: "agentdash", version: VERSION });
  expect(client.getProtocolEra()).toBe(era);
});
