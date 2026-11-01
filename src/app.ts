import { extname, join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";

export const VERSION = "0.0.0";

/** Builds the HTTP app: MCP at `/mcp`, the built web UI from `webRoot` (an absolute path). */
export function createApp(webRoot: string) {
  const mcp = createMcpHandler(() => new McpServer({ name: "agentdash", version: VERSION }), {
    onerror: (error) => console.error(error),
  });
  const app = new Hono();
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  app.use("/*", serveStatic({ root: webRoot }));
  const indexHtml = serveStatic({ path: join(webRoot, "index.html") });
  // A missing file (stale hashed asset) must 404; only client-side routes get index.html.
  app.use("*", async (c, next) => (extname(c.req.path) ? c.notFound() : indexHtml(c, next)));
  return { app, close: mcp.close };
}
