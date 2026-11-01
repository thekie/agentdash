import { test as base, expect } from "vitest";
import { StorageError } from "./errors.ts";
import { createStorage, type Storage } from "./storage.ts";

/** A test with a fresh in-memory Storage. */
export const test = base.extend<{ storage: Storage }>({
  // biome-ignore lint/correctness/noEmptyPattern: Vitest fixtures require object destructuring
  storage: async ({}, use) => {
    const storage = createStorage(":memory:");
    await use(storage);
    storage.close();
  },
});

/** Runs `write` and returns the `StorageError` it throws, failing the test if it doesn't throw one. */
export function failureOf(write: () => unknown): StorageError {
  try {
    write();
  } catch (error) {
    if (error instanceof StorageError) return error;
    throw error;
  }
  expect.fail("expected a StorageError");
}
