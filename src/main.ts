#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { parseOptions } from "./options.ts";

const { port, dataDir } = parseOptions(process.argv.slice(2));
mkdirSync(dataDir, { recursive: true });

const { app } = createApp(fileURLToPath(new URL("../dist/web", import.meta.url)));
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  const url = `http://127.0.0.1:${info.port}`;
  console.log(`agentdash running at ${url} (data: ${dataDir})`);
  console.log(`Connect Claude Code: claude mcp add --transport http agentdash ${url}/mcp`);
});
