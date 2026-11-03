import { expect, test } from "vitest";
import type { ColumnType } from "../src/storage/storage.ts";
import { formatAxisValue, formatDate, formatValue, splitUnit } from "./format.ts";

const euro: ColumnType = { type: "money", currency: "EUR" };
const kg: ColumnType = { type: "number", format: "plain", unit: "kg" };
const share: ColumnType = { type: "number", format: "percent" };

test.for([
  [euro, 7400, "€7,400"],
  [euro, 12.5, "€12.50"],
  [kg, 82.64, "82.64 kg"],
  [share, 0.452, "45.2%"],
  [{ type: "boolean" }, true, "Yes"],
  [{ type: "text" }, null, "—"],
  [{ type: "datetime", timezone: "UTC" }, "2026-10-25T08:30:00Z", "25 Oct, 08:30"],
] as const)("%o formats %s as %s", ([type, value, expected]) => {
  expect(formatValue(type, value)).toBe(expected);
});

test("a date shows its year only outside the current year", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  expect([formatDate("2026-10-31", now), formatDate("2025-10-31", now)]).toEqual([
    "31 Oct",
    "31 Oct 2025",
  ]);
});

test.for([
  [euro, 2000, "€2K"],
  [kg, 1500, "1.5K kg"],
  [kg, 80, "80 kg"],
] as const)("an axis shortens %o %s to %s", ([type, value, expected]) => {
  expect(formatAxisValue(type, value)).toBe(expected);
});

test.for([
  [kg, 82.6, ["82.6", "kg"]],
  [share, 0.7, ["70", "%"]],
  [euro, 21050, ["€21,050"]],
] as const)("a big %o value %s splits into %o", ([type, value, expected]) => {
  expect(splitUnit(type, value)).toEqual(expected);
});
