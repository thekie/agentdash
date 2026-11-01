#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, serverInfo } from "./app.ts";
import { HOST, parseOptions } from "./options.ts";

const { port, dataDir } = parseOptions(process.argv.slice(2));
mkdirSync(dataDir, { recursive: true });

const { app, close } = createApp(fileURLToPath(new URL("../dist/web", import.meta.url)));
const server = serve({ fetch: app.fetch, hostname: HOST, port }, (info) => {
  const url = `http://${HOST}:${info.port}`;
  const desktop = { [serverInfo.name]: { command: "npx", args: ["mcp-remote", `${url}/mcp`] } };
  console.log(`agentdash running at ${url} (data: ${dataDir})

Connect Claude Code:
  claude mcp add --transport http ${serverInfo.name} ${url}/mcp

Connect Claude Desktop: add under "mcpServers" in claude_desktop_config.json:
  ${JSON.stringify(desktop).slice(1, -1)}`);
});

async function shutdown() {
  await close();
  server.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
