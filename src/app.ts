import { extname, join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import pkg from "../package.json" with { type: "json" };

/** The name and version that the MCP server reports to a client. */
export const serverInfo = { name: pkg.name, version: pkg.version };

/**
 * Creates the HTTP app, with MCP at `/mcp` and the web UI from `webRoot`, an absolute path. `close`
 * stops the MCP handler.
 */
export function createApp(webRoot: string) {
  const mcp = createMcpHandler(() => new McpServer(serverInfo), {
    onerror: (error) => console.error(error),
  });
  const app = new Hono();
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  app.use("/*", serveStatic({ root: webRoot }));
  const indexHtml = serveStatic({ path: join(webRoot, "index.html") });
  // `serveStatic` above already served every file that exists. A path with a file extension that
  // reaches this point is a missing asset, so it gets a 404. Only a client-side route gets
  // `index.html`.
  app.use("*", async (c, next) => (extname(c.req.path) ? c.notFound() : indexHtml(c, next)));
  return { app, close: mcp.close };
}
