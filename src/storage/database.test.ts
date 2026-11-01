import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { migrate, migrations } from "./database.ts";

function userVersion(sqlite: DatabaseSync): unknown {
  return sqlite.prepare("PRAGMA user_version").get()?.user_version;
}

test("a failing migration is rolled back and the ones before it stay applied", () => {
  const sqlite = new DatabaseSync(":memory:");
  const entries = [
    "CREATE TABLE first (x INTEGER)",
    "CREATE TABLE second (x INTEGER); SELECT nope",
  ];
  expect(() => migrate(sqlite, entries)).toThrow();
  expect(userVersion(sqlite)).toBe(1);
  expect(sqlite.isTransaction).toBe(false);
  expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([
    { name: "first" },
  ]);
  sqlite.close();
});

test("a migration that ran is not run again", () => {
  const sqlite = new DatabaseSync(":memory:");
  migrate(sqlite, ["CREATE TABLE first (x INTEGER)"]);
  migrate(sqlite, ["CREATE TABLE first (x INTEGER)", "CREATE TABLE second (x INTEGER)"]);
  expect(userVersion(sqlite)).toBe(2);
  sqlite.close();
});

// An installed database has run these entries, and it never runs an edited entry again.
// Add a new entry instead of changing a hash here.
test("shipped migrations do not change", () => {
  const hashes = migrations.map((entry) => createHash("sha256").update(entry).digest("hex"));
  expect(hashes).toMatchInlineSnapshot(`
    [
      "eb90d49dbaff079010ce20499a43a177955b8ec1c165e0d4092aa7907ed67502",
    ]
  `);
});
