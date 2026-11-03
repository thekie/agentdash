import { expect, test } from "vitest";
import type { ColumnType } from "../src/storage/storage.ts";
import {
  chartData,
  checklistRows,
  isOverdue,
  kpiData,
  niceScale,
  openFirst,
  progressRows,
  smoothPath,
} from "./widget-data.ts";

const text: ColumnType = { type: "text" };
const num: ColumnType = { type: "number", format: "plain" };
const result = (columns: [string, ColumnType][], rows: Record<string, unknown>[]) => ({
  columns: columns.map(([name, type]) => ({ name, type })),
  rows,
  truncated: false,
});

test("a series column splits one y column into one series per value", () => {
  const rows = [
    { week: "W1", sport: "Run", min: 90 },
    { week: "W1", sport: "Ride", min: 120 },
    { week: "W2", sport: "Ride", min: 60 },
  ];
  const data = chartData(
    result(
      [
        ["week", text],
        ["sport", text],
        ["min", num],
      ],
      rows,
    ),
    { x: "week", y: "min", series: "sport" },
  );
  expect(data.xs).toEqual(["W1", "W2"]);
  expect(data.series).toEqual([
    { name: "Run", values: [90, 0] },
    { name: "Ride", values: [120, 60] },
  ]);
});

test("each y column is one series", () => {
  const rows = [{ week: "W1", run: 18, ride: 30 }];
  const data = chartData(
    result(
      [
        ["week", text],
        ["run", num],
        ["ride", num],
      ],
      rows,
    ),
    {
      x: "week",
      y: ["run", "ride"],
    },
  );
  expect(data.series.map((s) => [s.name, s.values])).toEqual([
    ["run", [18]],
    ["ride", [30]],
  ]);
});

test("a kpi without x reads the first row and with x every row", () => {
  const r = result(
    [
      ["d", { type: "date" }],
      ["v", num],
    ],
    [
      { d: "2026-01-01", v: 1 },
      { d: "2026-02-01", v: 3 },
    ],
  );
  expect(kpiData(r, { y: "v" }).values).toEqual([1]);
  expect(kpiData(r, { x: "d", y: "v" }).values).toEqual([1, 3]);
});

test("a kpi skips empty values", () => {
  expect(kpiData(result([["v", num]], [{ v: null }]), { y: "v" }).values).toEqual([]);
});

test("the target Slot wins over config.target", () => {
  const r = result(
    [
      ["n", text],
      ["v", num],
      ["t", num],
    ],
    [{ n: "A", v: 5, t: 10 }],
  );
  expect(progressRows(r, { label: "n", value: "v", target: "t" }, 99)).toEqual([
    { label: "A", value: 5, target: 10 },
  ]);
  expect(progressRows(r, { value: "v" }, 99)).toEqual([{ value: 5, target: 99 }]);
});

test("checklist rows come from the label, done and due Slots", () => {
  const r = result(
    [
      ["l", text],
      ["d", { type: "boolean" }],
      ["due", { type: "date" }],
    ],
    [
      { l: "Walk", d: false, due: "2026-11-01" },
      { l: "Stretch", d: true, due: null },
    ],
  );
  expect(checklistRows(r, { label: "l", done: "d", due: "due" })).toEqual([
    { text: "Walk", done: false, due: "2026-11-01" },
    { text: "Stretch", done: true },
  ]);
});

test("open items come first in their order", () => {
  const items = [
    { text: "a", done: true },
    { text: "b", done: false },
    { text: "c", done: false },
  ];
  expect(openFirst(items).map((i) => i.text)).toEqual(["b", "c", "a"]);
});

test("only an open item past its due date is overdue", () => {
  const now = new Date(2026, 10, 3, 12);
  expect(
    [
      { text: "late", done: false, due: "2026-11-02" },
      { text: "today", done: false, due: "2026-11-03" },
      { text: "done", done: true, due: "2026-11-02" },
      { text: "no due", done: false },
    ].map((i) => isOverdue(i, now)),
  ).toEqual([true, false, false, false]);
});

test.for([
  [[82.6, 83.9], false, { min: 82.5, max: 84, ticks: [82.5, 83, 83.5, 84] }],
  [[90, 210], true, { min: 0, max: 300, ticks: [0, 100, 200, 300] }],
  [[5, 5], false, { min: 4, max: 6, ticks: [4, 6] }],
] as const)("the scale of %o starting at zero %s is %o", ([values, atZero, expected]) => {
  expect(niceScale([...values], atZero)).toEqual(expected);
});

test("a smooth path starts at the first point and ends at the last", () => {
  const d = smoothPath([
    [0, 0],
    [10, 5],
    [20, 0],
  ]);
  expect(d.startsWith("M0,0 C")).toBe(true);
  expect(d.endsWith(" 20,0")).toBe(true);
  expect(d.match(/C/g)).toHaveLength(2);
});
