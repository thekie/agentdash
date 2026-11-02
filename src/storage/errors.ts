type ErrorCode = "not_found" | "invalid" | "conflict" | "archived";

/** Describes where a problem is in the input of an Agent, for example `["rows", 3, "amount"]`. */
export type Path = (string | number)[];

/** Describes one problem in the input of an Agent. */
export interface Issue {
  path: Path;
  problem: string;
  expected?: string;
  validValues?: string[];
}

interface ErrorDetails {
  issues?: Issue[];
  /** The stored state that caused a `conflict`. */
  current?: unknown;
  hint?: string;
}

/** Represents a failure that an Agent can correct before it tries the call again. */
export class StorageError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Throws `StorageError` `invalid` with all of `issues` if the list is not empty. */
export function assertNoIssues(issues: Issue[], message: string): void {
  if (issues.length > 0) throw new StorageError("invalid", message, { issues });
}

/**
 * Throws `StorageError` `conflict` with the result of `current` if the version of `entity` is not
 * `expectedVersion`.
 */
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
