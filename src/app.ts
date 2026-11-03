import { extname, join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import pkg from "../package.json" with { type: "json" };
import { instructions } from "./instructions.ts";
import type { Storage } from "./storage/storage.ts";
import { registerTools } from "./tools.ts";
import { createWebApi } from "./web-api.ts";

/** The name and version that the MCP server reports to a client. */
export const serverInfo = { name: pkg.name, version: pkg.version };

/**
 * Creates the HTTP app, with the MCP tools over `storage` at `/mcp`, the reads of the web UI at `/api`, and the web UI from `webRoot`, an
 * absolute path. `close` stops the MCP handler.
 */
export function createApp(webRoot: string, storage: Storage) {
  const createServer = () => {
    const server = new McpServer(serverInfo, { instructions });
    registerTools(server, storage);
    return server;
  };
  const mcp = createMcpHandler(createServer, {
    onerror: (error) => console.error(error),
  });
  const app = new Hono();
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  app.route("/api", createWebApi(storage));
  app.use("/*", serveStatic({ root: webRoot }));
  const indexHtml = serveStatic({ path: join(webRoot, "index.html") });
  // `serveStatic` above already served every file that exists. A path with a file extension that
  // reaches this point is a missing asset, so it gets a 404. Only a client-side route gets
  // `index.html`.
  app.use("*", async (c, next) => (extname(c.req.path) ? c.notFound() : indexHtml(c, next)));
  return { app, close: mcp.close };
}
