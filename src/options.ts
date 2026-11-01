import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 4280;

const Options = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(DEFAULT_PORT),
  "data-dir": z.string().default(join(homedir(), ".agentdash")),
});

export interface Options {
  port: number;
  dataDir: string;
}

/**
 * Reads `--port` and `--data-dir` from command-line arguments, with `dataDir` resolved to an
 * absolute path. Throws on an unknown flag or a port outside 0 to 65535.
 */
export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, "data-dir": { type: "string" } },
  });
  const result = Options.safeParse(values);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `--${i.path.join(".")}: ${i.message}`);
    throw new Error(issues.join("\n"));
  }
  return { port: result.data.port, dataDir: resolve(result.data["data-dir"]) };
}
