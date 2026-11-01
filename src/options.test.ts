import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_PORT, parseOptions } from "./options.ts";

test("defaults to the default port and a data dir in the home directory", () => {
  expect(parseOptions([])).toEqual({ port: DEFAULT_PORT, dataDir: join(homedir(), ".agentdash") });
});

test("takes --port and resolves --data-dir to an absolute path", () => {
  expect(parseOptions(["--port", "5000", "--data-dir", "tmp/data"])).toEqual({
    port: 5000,
    dataDir: resolve("tmp/data"),
  });
});

test.for(["abc", "-1", "70000", "1.5"])("rejects --port %s", (port) => {
  expect(() => parseOptions(["--port", port])).toThrow("--port");
});

test("rejects unknown flags", () => {
  expect(() => parseOptions(["--host", "0.0.0.0"])).toThrow();
});
