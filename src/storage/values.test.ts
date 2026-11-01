import { expect, test } from "vitest";
import { type ColumnType, mergeEnumOptions, storedType } from "./columns.ts";
import { formatValue, parseValue, retypeValue } from "./values.ts";

const text: ColumnType = { type: "text" };
const number: ColumnType = { type: "number", format: "plain" };
const eur: ColumnType = { type: "money", currency: "EUR" };
const jpy: ColumnType = { type: "money", currency: "JPY" };
const date: ColumnType = { type: "date" };
const datetime: ColumnType = { type: "datetime" };
const boolean: ColumnType = { type: "boolean" };
const mood: ColumnType = {
  type: "enum",
  options: [
    { id: "o1", label: "good" },
    { id: "o2", label: "bad", archivedAt: "2026-01-01T00:00:00.000Z" },
  ],
};

test.for<[string, ColumnType, unknown, unknown]>([
  ["text", text, "hello", "hello"],
  ["number", number, 72.5, 72.5],
  ["money as a number", eur, 12.34, 1234],
  ["money as a string", eur, "-0.5", -50],
  ["money without minor units", jpy, 1200, 1200],
  ["date", date, "2026-02-28", "2026-02-28"],
  [
    "datetime with an offset, stored in UTC",
    datetime,
    "2026-03-01T10:00:00+02:00",
    "2026-03-01T08:00:00.000Z",
  ],
  ["boolean", boolean, true, 1],
  ["enum by label", mood, "good", "o1"],
  ["null in any column", eur, null, null],
])("%s is stored", ([, column, value, stored]) => {
  expect(parseValue(column, value)).toEqual({ ok: true, stored });
});

test.for<[string, ColumnType, unknown]>([
  ["a number in text", text, 5],
  ["NaN as number", number, Number.NaN],
  ["more decimals than the currency allows", eur, 1.234],
  ["decimals in a currency without minor units", jpy, 1.5],
  ["money in exponent form", eur, 1e-7],
  ["an impossible date", date, "2026-02-30"],
  ["a datetime without a zone", datetime, "2026-03-01T10:00:00"],
  ["a string as boolean", boolean, "true"],
  ["an Archived enum option", mood, "bad"],
])("%s is refused", ([, column, value]) => {
  expect(parseValue(column, value).ok).toBe(false);
});

test("a refused enum value lists the live labels", () => {
  expect(parseValue(mood, "meh")).toEqual({
    ok: false,
    expected: "one of the option labels",
    validValues: ["good"],
  });
});

test.for<[string, ColumnType, string | number, unknown]>([
  ["money in major units", eur, 1234, 12.34],
  ["boolean", boolean, 1, true],
  ["enum by label, even when Archived", mood, "o2", "bad"],
])("%s reads back in the Agent's form", ([, column, stored, formatted]) => {
  expect(formatValue(column, stored)).toEqual(formatted);
});

test.for<[string, ColumnType, ColumnType, string | number, string | number | null | undefined]>([
  ["number to text", number, text, 3.5, "3.5"],
  ["numeric text to number", text, number, "42", 42],
  ["text to money", text, eur, "9.99", 999],
  ["datetime to date", datetime, date, "2026-03-01T08:00:00.000Z", "2026-03-01"],
  ["date to datetime", date, datetime, "2026-03-01", "2026-03-01T00:00:00.000Z"],
  ["text to boolean", text, boolean, "TRUE", 1],
  ["text to enum by label", text, mood, "good", "o1"],
  ["prose to number does not convert", text, number, "about five", undefined],
  ["a fractional number to JPY does not convert", number, jpy, 1.5, undefined],
])("retyping %s", ([, from, to, stored, expected]) => {
  expect(retypeValue(from, to, stored)).toBe(expected);
});

test("new enum options get fresh ids, renamed ones keep theirs, missing ones are Archived", () => {
  const stored = [
    { id: "o1", label: "good" },
    { id: "o2", label: "bad" },
  ];
  const merged = mergeEnumOptions(
    stored,
    [
      { id: "o1", label: "great" },
      { label: "okay", color: "amber" },
    ],
    "2026-01-01T00:00:00.000Z",
  );
  expect(merged).toEqual([
    { id: "o1", label: "great" },
    { id: "o3", label: "okay", color: "amber" },
    { id: "o2", label: "bad", archivedAt: "2026-01-01T00:00:00.000Z" },
  ]);
});

test("a stored number type gets the plain format by default", () => {
  expect(storedType({ type: "number" }, "now")).toEqual({ type: "number", format: "plain" });
});
