export type ErrorCode = "not_found" | "invalid" | "conflict" | "archived";

/** Where in the Agent's input a problem is, such as `["rows", 3, "amount"]`. */
export type Path = (string | number)[];

export interface Issue {
  path: Path;
  problem: string;
  expected?: string;
  validValues?: string[];
}

export interface ErrorDetails {
  issues?: Issue[];
  /** The entity as stored now, so the Agent can merge and retry without another read. */
  current?: unknown;
  hint?: string;
}

/** A failure an Agent can recover from. The MCP tools turn it into an `isError` result. */
export class StorageError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Throws `invalid` listing every issue, when there is at least one. */
export function assertNoIssues(issues: Issue[], message: string): void {
  if (issues.length > 0) throw new StorageError("invalid", message, { issues });
}

/** Throws `conflict` carrying the entity's current state when its version is not `expectedVersion`. */
export function assertVersion(
  entity: { version: number },
  expectedVersion: number,
  current: () => unknown,
): void {
  if (entity.version !== expectedVersion) {
    throw new StorageError(
      "conflict",
      `Expected version ${expectedVersion}, found ${entity.version}`,
      {
        current: current(),
        hint: "Merge your change into `current` and retry with its version.",
      },
    );
  }
}
