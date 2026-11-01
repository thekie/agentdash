import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface Options {
  port: number;
  dataDir: string;
}

export const DEFAULT_PORT = 4280;

export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      "data-dir": { type: "string" },
    },
  });
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer from 0 to 65535, got "${values.port}"`);
  }
  // ponytail: home-dir default until packaging decides the data directory location
  const dataDir = resolve(values["data-dir"] ?? join(homedir(), ".agentdash"));
  return { port, dataDir };
}
