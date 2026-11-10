import { expect, test } from "vitest";
import type { ColumnType } from "../src/storage/storage.ts";
import {
  chartData,
  checklistRows,
  foldOther,
  isOverdue,
  kpiData,
  niceScale,
  openFirst,
  progressRows,
  smoothPath,
} from "./widget-data.ts";

const text: ColumnType = { type: "text" };
const num: ColumnType = { type: "number", format: "plain" };
const result = (
  columns: ([string, ColumnType] | [string, ColumnType, string])[],
  rows: Record<string, unknown>[],
) => ({
  columns: columns.map(([name, type, label]) => ({ name, type, ...(label && { label }) })),
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
    { key: "Run", name: "Run", values: [90, 0] },
    { key: "Ride", name: "Ride", values: [120, 60] },
  ]);
});

test("each y column is one series, named by its label", () => {
  const rows = [{ week: "W1", run: 18, ride: 30 }];
  const data = chartData(
    result(
      [
        ["week", text],
        ["run", num, "Running"],
        ["ride", num],
      ],
      rows,
    ),
    {
      x: "week",
      y: ["run", "ride"],
    },
  );
  expect(data.series.map((s) => [s.key, s.name, s.values])).toEqual([
    ["run", "Running", [18]],
    ["ride", "ride", [30]],
  ]);
});

const series = (name: string, values: number[]) => ({ key: name, name, values });

test("folding keeps the largest series in their order and sums the rest into Other", () => {
  const data = {
    xs: ["Jun", "Jul"],
    yType: num,
    series: [
      series("Rent", [1200, 1200]),
      series("Gifts", [60, 0]),
      series("Groceries", [400, 420]),
      series("Leisure", [10, 20]),
    ],
  };
  expect(foldOther(data, 2).series).toEqual([
    series("Rent", [1200, 1200]),
    series("Groceries", [400, 420]),
    { key: "\0other", name: "Other", values: [70, 20], members: ["Gifts", "Leisure"] },
  ]);
});

test("folding leaves a chart with no more series than it keeps unchanged", () => {
  const data = { xs: ["Jun"], yType: num, series: [series("Rent", [1]), series("Gifts", [2])] };
  expect(foldOther(data, 2)).toBe(data);
});

test.for([
  [{ y: "v" }, [1]],
  [{ x: "d", y: "v" }, [1, 3]],
] as const)("a kpi with Slots %o reads %o", ([slots, expected]) => {
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
  expect(kpiData(r, slots).values).toEqual(expected);
});

test("a kpi skips empty values", () => {
  expect(kpiData(result([["v", num]], [{ v: null }]), { y: "v" }).values).toEqual([]);
});

test.for([
  [{ label: "n", value: "v", target: "t" }, [{ label: "A", value: 5, target: 10 }]],
  [{ value: "v" }, [{ value: 5, target: 99 }]],
] as const)(
  "progress Slots %o read %o, the target Slot winning over config.target",
  ([slots, expected]) => {
    const r = result(
      [
        ["n", text],
        ["v", num],
        ["t", num],
      ],
      [{ n: "A", v: 5, t: 10 }],
    );
    expect(progressRows(r, slots, 99)).toEqual(expected);
  },
);

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
