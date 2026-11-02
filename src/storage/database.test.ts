import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { createId, migrate, migrations, openDatabase } from "./database.ts";

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

test.each([
  [
    "dashboards",
    "d",
    "INSERT INTO dashboards (id, ord, slug, title, createdAt, updatedAt) VALUES (?, 0, 'x', 'x', '', '')",
  ],
  [
    "widgets",
    "w",
    "INSERT INTO widgets (id, dashboardId, ord, type, config, createdAt, updatedAt) VALUES (?, 'd_0000000000000', 0, 'x', '{}', '', '')",
  ],
  [
    "stores",
    "s",
    "INSERT INTO stores (id, name, columns, key, nextColumn, createdAt, updatedAt) VALUES (?, 'x', '[]', '[]', 0, '', '')",
  ],
] as const)("%s accept only ids that createId makes", (_table, prefix, insert) => {
  const db = openDatabase(":memory:");
  db.run(
    "INSERT INTO dashboards (id, ord, slug, title, createdAt, updatedAt) VALUES ('d_0000000000000', 0, 'root', 'x', '', '')",
  );
  const other = prefix === "d" ? "w" : "d";
  for (const bad of [
    `${other}_0000000000000`,
    `${prefix}_000000000000`,
    `${prefix}_00000000000000`,
    `${prefix}_000000000000A`,
    `${prefix}_00000000000-0`,
  ]) {
    expect(() => db.run(insert, bad), bad).toThrow(/CHECK constraint failed/);
  }
  db.run(insert, createId(prefix));
  db.close();
});

// An installed database has run these entries, and it never runs an edited entry again.
// Add a new entry instead of changing a hash here.
test("shipped migrations do not change", () => {
  const hashes = migrations.map((entry) => createHash("sha256").update(entry).digest("hex"));
  expect(hashes).toMatchInlineSnapshot(`
    [
      "29a59dba36829827c6dae17a3c3bd67cbccb8ebba4cd9dde2d5519c5a513055e",
    ]
  `);
});
