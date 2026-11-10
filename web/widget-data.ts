import type { ColumnType } from "../src/storage/storage.ts";
import type { WidgetView } from "../src/web-api.ts";
import { formatValue } from "./format.ts";

/** Describes the rows of a Projection as the web UI reads them. */
export type Result = NonNullable<WidgetView["result"]>;
/** Describes the Slots of a Projection: each names one output column or a list of them. */
export type Slots = Record<string, string | string[]>;

/** Describes one line or one bar colour of a chart. */
export interface Series {
  name: string;
  values: number[];
}

/** Describes what a chart draws: one label per x position and the series above them. */
export interface ChartData {
  xs: string[];
  series: Series[];
  yType: ColumnType;
}

/** Returns the header of the output column `name`: its label, else its name. */
function labelOf(result: Result, name: string): string {
  return result.columns.find((c) => c.name === name)?.label ?? name;
}

/** Returns the type of the output column `name`. */
export function columnType(result: Result, name: string | undefined): ColumnType | undefined {
  return result.columns.find((c) => c.name === name)?.type;
}

function columnsOf(slot: string | string[] | undefined): string[] {
  if (slot === undefined) return [];
  return typeof slot === "string" ? [slot] : slot;
}

/** Returns the first column that the Slot `name` names. */
export function slotOf(slots: Slots, name: string): string | undefined {
  const [first] = columnsOf(slots[name]);
  return first;
}

const fallbackType: ColumnType = { type: "number", format: "plain" };

/**
 * Returns the series of a chart. Each `y` column is one series, or the values of the `series`
 * column split one `y` column into several. A missing value is 0.
 */
export function chartData(result: Result, slots: Slots): ChartData {
  const x = slotOf(slots, "x") ?? "";
  const ys = columnsOf(slots.y);
  const seriesColumn = slotOf(slots, "series");
  const xType = columnType(result, x) ?? { type: "text" };
  const yType = columnType(result, ys[0]) ?? fallbackType;
  const keys = [...new Set(result.rows.map((row) => String(row[x])))];
  const xs = keys.map((key) =>
    formatValue(xType, result.rows.find((r) => String(r[x]) === key)?.[x]),
  );
  const valueAt = (key: string, rows: Record<string, unknown>[], y: string) =>
    Number(rows.find((r) => String(r[x]) === key)?.[y] ?? 0);
  if (seriesColumn === undefined) {
    return {
      xs,
      yType,
      series: ys.map((y) => ({
        name: labelOf(result, y),
        values: keys.map((k) => valueAt(k, result.rows, y)),
      })),
    };
  }
  const y = ys[0] ?? "";
  const names = [...new Set(result.rows.map((row) => String(row[seriesColumn])))];
  const series = names.map((name) => {
    const rows = result.rows.filter((r) => String(r[seriesColumn]) === name);
    return { name, values: keys.map((k) => valueAt(k, rows, y)) };
  });
  return { xs, yType, series };
}

/** Describes what a kpi draws: the latest value and, with an `x` Slot, the values before it. */
export interface KpiData {
  type: ColumnType;
  values: number[];
}

/**
 * Returns the values of a kpi. Without an `x` Slot it is the `y` value of the first row. With one it
 * is every `y` value, the latest last.
 */
export function kpiData(result: Result, slots: Slots): KpiData {
  const y = slotOf(slots, "y") ?? "";
  const type = columnType(result, y) ?? fallbackType;
  const rows = slotOf(slots, "x") === undefined ? result.rows.slice(0, 1) : result.rows;
  return {
    type,
    values: rows
      .map((r) => r[y])
      .filter((v) => v !== null)
      .map(Number),
  };
}

/** Describes one bar of a progress Widget. */
export interface ProgressRow {
  label?: string;
  value: number;
  target: number;
}

/**
 * Returns the bars of a progress Widget. Without a `label` Slot there is one bar, from the first
 * row. The `target` Slot wins over `config.target`.
 */
export function progressRows(result: Result, slots: Slots, target?: number): ProgressRow[] {
  const value = slotOf(slots, "value") ?? "";
  const targetSlot = slotOf(slots, "target");
  const label = slotOf(slots, "label");
  const rows = label === undefined ? result.rows.slice(0, 1) : result.rows;
  return rows.map((row) => ({
    ...(label !== undefined && { label: String(row[label] ?? "—") }),
    value: Number(row[value] ?? 0),
    target: Number(targetSlot === undefined ? target : row[targetSlot]),
  }));
}

/** Describes a checklist item. */
export interface ChecklistItem {
  text: string;
  done: boolean;
  due?: string | undefined;
}

/** Returns the items of a checklist read from the `label`, `done` and `due` Slots. */
export function checklistRows(result: Result, slots: Slots): ChecklistItem[] {
  const [label = "", done = "", due] = ["label", "done", "due"].map((s) => slotOf(slots, s));
  return result.rows.map((row) => ({
    text: String(row[label] ?? ""),
    done: row[done] === true,
    ...(due !== undefined && typeof row[due] === "string" && { due: row[due] }),
  }));
}

/** Returns the items with the open ones first, keeping the order within each group. */
export function openFirst(items: ChecklistItem[]): ChecklistItem[] {
  return [...items.filter((i) => !i.done), ...items.filter((i) => i.done)];
}

/** Reports whether an open item is past its due date on the local day of `now`. */
export function isOverdue(item: ChecklistItem, now = new Date()): boolean {
  const today = now.toLocaleDateString("en-CA");
  return !item.done && item.due !== undefined && item.due < today;
}

/** Describes the y axis of a chart. */
export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  return ([1, 2, 2.5, 5, 10].find((f) => raw <= f * power) ?? 10) * power;
}

/**
 * Returns a y axis with three to four round ticks that covers `values`. A bar axis starts at zero.
 */
export function niceScale(values: number[], isZeroBased: boolean): Scale {
  const low = isZeroBased ? Math.min(0, ...values) : Math.min(...values);
  const high = Math.max(...values);
  const step = niceStep((high - low || Math.abs(high) || 1) / 3);
  const min = Math.floor(low / step) * step;
  const max = Math.max(Math.ceil(high / step) * step, min + step);
  const ticks: number[] = [];
  for (let t = min; t <= max + step / 1e6; t += step) ticks.push(Number(t.toPrecision(12)));
  return { min, max, ticks };
}

/** Returns an SVG path through `points` as a smooth Catmull-Rom curve. */
export function smoothPath(points: [number, number][]): string {
  const point = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))] ?? [0, 0];
  let d = `M${point(0).join(",")}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [point(i - 1), point(i), point(i + 1), point(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1.join(",")} ${c2.join(",")} ${p2.join(",")}`;
  }
  return d;
}
