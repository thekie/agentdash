import type { ColumnType } from "../src/storage/storage.ts";

const plain = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const fullDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function currency(code: string, options: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: code,
    trailingZeroDisplay: "stripIfInteger",
    ...options,
  });
}

/** Returns a date as "25 Oct", with the year if it is not the year of `now`. */
export function formatDate(iso: string, now = new Date()): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  const format = date.getUTCFullYear() === now.getUTCFullYear() ? shortDate : fullDate;
  return format.format(date);
}

function formatDatetime(iso: string, timezone: string | undefined): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(timezone && { timeZone: timezone }),
  });
}

function formatNumber(type: Extract<ColumnType, { type: "number" }>, value: number): string {
  if (type.format === "percent") return percent.format(value);
  return type.unit ? `${plain.format(value)} ${type.unit}` : plain.format(value);
}

/** Returns a value of a query result as the Owner reads it. `null` is "—". */
export function formatValue(type: ColumnType, value: unknown): string {
  if (value === null || value === undefined) return "—";
  switch (type.type) {
    case "money":
      return currency(type.currency).format(Number(value));
    case "number":
      return formatNumber(type, Number(value));
    case "date":
      return formatDate(String(value));
    case "datetime":
      return formatDatetime(String(value), type.timezone);
    case "boolean":
      return value ? "Yes" : "No";
    default:
      return String(value);
  }
}

/** Returns a number for an axis label, shortened from 2,000 to 2K. */
export function formatAxisValue(type: ColumnType, value: number): string {
  if (Math.abs(value) < 1000) return formatValue(type, value);
  const compact = { notation: "compact", maximumFractionDigits: 1 } as const;
  if (type.type === "money") return currency(type.currency, compact).format(value);
  const short = new Intl.NumberFormat("en", compact).format(value);
  return type.type === "number" && type.unit ? `${short} ${type.unit}` : short;
}

/**
 * Returns a big number split into the figure and the unit that follows it in smaller type, such as
 * `["82.6", "kg"]`. A currency symbol stays in front of the figure.
 */
export function splitUnit(type: ColumnType, value: unknown): [string, string?] {
  if (value === null || value === undefined) return ["—"];
  if (type.type === "number" && type.format === "percent") {
    return [plain.format(Number(value) * 100), "%"];
  }
  if (type.type === "number" && type.unit) return [plain.format(Number(value)), type.unit];
  return [formatValue(type, value)];
}
