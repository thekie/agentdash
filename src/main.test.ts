import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("the server prints how to connect Claude Code and Claude Desktop, then exits on SIGTERM", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agentdash-data-"));
  const child = spawn(process.execPath, ["src/main.ts", "--port", "0", "--data-dir", dataDir]);
  let output = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.includes("claude_desktop_config.json")) break;
  }
  const mcpUrl = output.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)?.[0];
  expect(mcpUrl).toBeDefined();
  expect(output).toContain(`claude mcp add --transport http agentdash ${mcpUrl}`);
  expect(output).toContain(`"agentdash":{"command":"npx","args":["mcp-remote","${mcpUrl}"]}`);

  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  expect(code).toBe(0);
  rmSync(dataDir, { recursive: true });
});
