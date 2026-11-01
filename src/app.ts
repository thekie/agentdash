import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";

export const VERSION = "0.0.0";

export function createApp(webRoot: string) {
  const mcp = createMcpHandler(() => new McpServer({ name: "agentdash", version: VERSION }));
  const app = new Hono();
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: join(webRoot, "index.html") }));
  return { app, close: mcp.close };
}
