import { z } from "zod";
import type { ColumnType, EnumOption } from "./columns.ts";

/** A value as SQLite holds it in a Data Store table. */
export type StoredValue = string | number | null;

export type ParsedValue =
  | { ok: true; stored: StoredValue }
  | { ok: false; expected: string; validValues?: string[] };

interface Codec {
  sqlType: "TEXT" | "REAL" | "INTEGER";
  expected: string;
  validValues?: string[];
  /** Returns the stored form, or `undefined` when the value does not fit the type. */
  parse(value: unknown): StoredValue | undefined;
  format(stored: string | number): unknown;
}

const isoDatetime = z.iso.datetime({ offset: true });

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

/** Converts a decimal in major units to integer minor units, refusing extra decimals. */
function minorUnits(value: unknown, digits: number): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  const [, sign = "", whole = "", fraction = ""] = match ?? [];
  if (!match || fraction.length > digits) return undefined;
  const minor = Number(whole + fraction.padEnd(digits, "0"));
  return sign ? -minor : minor;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const codecs = {
  text: (): Codec => ({ sqlType: "TEXT", expected: "a string", parse: textValue, format: String }),
  number: (): Codec => ({
    sqlType: "REAL",
    expected: "a finite number",
    parse: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
    format: Number,
  }),
  money: (currency: string): Codec => {
    const { maximumFractionDigits: digits = 2 } = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions();
    return {
      sqlType: "INTEGER",
      expected: `a decimal in ${currency} with at most ${digits} decimals`,
      parse: (v) => minorUnits(v, digits),
      format: (s) => Number(s) / 10 ** digits,
    };
  },
  date: (): Codec => ({
    sqlType: "TEXT",
    expected: "a date as YYYY-MM-DD",
    parse: (v) => (isDate(v) ? v : undefined),
    format: String,
  }),
  datetime: (): Codec => ({
    sqlType: "TEXT",
    expected: "an ISO 8601 datetime with Z or an offset",
    parse: (v) =>
      isoDatetime.safeParse(v).success ? new Date(String(v)).toISOString() : undefined,
    format: String,
  }),
  boolean: (): Codec => ({
    sqlType: "INTEGER",
    expected: "true or false",
    parse: (v) => (typeof v === "boolean" ? Number(v) : undefined),
    format: (s) => s === 1,
  }),
  enum: (options: EnumOption[]): Codec => {
    const live = options.filter((o) => o.archivedAt === undefined);
    return {
      sqlType: "TEXT",
      expected: "one of the option labels",
      validValues: live.map((o) => o.label),
      parse: (v) => live.find((o) => o.label === v)?.id,
      format: (s) => options.find((o) => o.id === s)?.label ?? null,
    };
  },
};

function codecOf(column: ColumnType): Codec {
  switch (column.type) {
    case "money":
      return codecs.money(column.currency);
    case "enum":
      return codecs.enum(column.options);
    default:
      return codecs[column.type]();
  }
}

/** The SQLite type that holds values of this column type in a STRICT table. */
export function sqlTypeOf(column: ColumnType): Codec["sqlType"] {
  return codecOf(column).sqlType;
}

/** Checks an Agent's value against the column type and returns its stored form. `null` is always allowed. */
export function parseValue(column: ColumnType, value: unknown): ParsedValue {
  if (value === null) return { ok: true, stored: null };
  const codec = codecOf(column);
  const stored = codec.parse(value);
  if (stored !== undefined) return { ok: true, stored };
  const failure = { ok: false as const, expected: codec.expected };
  return codec.validValues ? { ...failure, validValues: codec.validValues } : failure;
}

/** Returns the value as Agents read and write it: money in major units, enums by label. */
export function formatValue(column: ColumnType, stored: StoredValue): unknown {
  return stored === null ? null : codecOf(column).format(stored);
}

/** Readings of a value to try, in order, when it moves to another column type. */
function retypeCandidates(value: unknown): unknown[] {
  if (typeof value !== "string") return [value, String(value)];
  const candidates: unknown[] = [value];
  if (value.trim() !== "" && Number.isFinite(Number(value))) candidates.push(Number(value));
  if (/^(true|false)$/i.test(value)) candidates.push(value.toLowerCase() === "true");
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) candidates.push(value.slice(0, 10));
  if (isDate(value)) candidates.push(`${value}T00:00:00Z`);
  return candidates;
}

/**
 * Converts a stored value from one column type to another. Returns `undefined` when it does not
 * convert, which a retype stores as empty.
 */
export function retypeValue(
  from: ColumnType,
  to: ColumnType,
  stored: StoredValue,
): StoredValue | undefined {
  if (stored === null) return null;
  for (const candidate of retypeCandidates(formatValue(from, stored))) {
    const parsed = parseValue(to, candidate);
    if (parsed.ok) return parsed.stored;
  }
  return undefined;
}
