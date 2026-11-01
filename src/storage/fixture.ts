import { test as base, expect } from "vitest";
import { StorageError } from "./errors.ts";
import { createStorage, type Storage } from "./storage.ts";

/**
 * The Vitest `test` function with a `storage` fixture that opens a new in-memory database for each
 * test.
 */
export const test = base.extend<{ storage: Storage }>({
  // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures require object destructuring
  storage: async ({}, use) => {
    const storage = createStorage(":memory:");
    await use(storage);
    storage.close();
  },
});

/**
 * Returns the `StorageError` that `write` throws. Fails the test if `write` throws nothing, and
 * throws any other error again.
 */
export function failureOf(write: () => unknown): StorageError {
  try {
    write();
  } catch (error) {
    if (error instanceof StorageError) return error;
    throw error;
  }
  expect.fail("expected a StorageError");
}
