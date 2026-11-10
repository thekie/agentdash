import { z } from "zod";

const currencies = new Set(Intl.supportedValuesOf("currency"));

/** The schema of a column key: letters, digits and `_`, with no digit first. */
export const ColumnKey = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "letters, digits and _, not starting with a digit");

const Text = z.object({ type: z.literal("text") });
const NumberType = z.object({
  type: z.literal("number"),
  format: z.enum(["plain", "percent"]).default("plain"),
  unit: z.string().min(1).optional(),
});
const Money = z.object({
  type: z.literal("money"),
  currency: z.string().refine((c) => currencies.has(c), "an ISO 4217 currency code such as EUR"),
});
const DateType = z.object({ type: z.literal("date") });
const Datetime = z.object({ type: z.literal("datetime"), timezone: z.string().optional() });
const BooleanType = z.object({ type: z.literal("boolean") });

/**
 * The schema of an enum option as an Agent writes it. An option with a known `id` renames that
 * option.
 */
export const EnumOptionSpec = z.object({
  id: z.string().optional(),
  label: z.string().min(1),
  color: z.string().optional(),
});
export type EnumOptionSpec = z.infer<typeof EnumOptionSpec>;

const EnumOption = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string().optional(),
  archivedAt: z.string().optional(),
});
/** Describes a stored enum option. An Archived option keeps its label for the rows that hold it. */
export type EnumOption = z.infer<typeof EnumOption>;

/** The schema of a column type as an Agent writes it. */
export const ColumnTypeSpec = z.discriminatedUnion("type", [
  Text,
  NumberType,
  Money,
  DateType,
  Datetime,
  BooleanType,
  z.object({ type: z.literal("enum"), options: z.array(EnumOptionSpec).min(1) }),
]);
export type ColumnTypeSpec = z.input<typeof ColumnTypeSpec>;
/** Describes a column type that `ColumnTypeSpec` has parsed, with its defaults filled in. */
export type ParsedColumnType = z.output<typeof ColumnTypeSpec>;

/** The schema of a column label: the header a Widget shows for the column. */
export const ColumnLabel = z.string().min(1);

const ColumnBase = z.object({ key: ColumnKey, label: ColumnLabel.optional() });

/** The schema of a column as an Agent writes it: a key, an optional label and a type. */
export const ColumnSpec = z.intersection(ColumnBase, ColumnTypeSpec);
export type ColumnSpec = z.input<typeof ColumnSpec>;
/** Describes a column that `ColumnSpec` has parsed, with its defaults filled in. */
export type ParsedColumnSpec = z.output<typeof ColumnSpec>;

const ColumnType = z.discriminatedUnion("type", [
  Text,
  NumberType,
  Money,
  DateType,
  Datetime,
  BooleanType,
  z.object({ type: z.literal("enum"), options: z.array(EnumOption) }),
]);
/** Describes the stored type of a column. */
export type ColumnType = z.infer<typeof ColumnType>;

/**
 * The schema of a column as it is stored. `physical` is the name of its SQL column, and it never
 * changes.
 */
export const Column = z.intersection(
  ColumnBase.extend({ physical: z.string(), archivedAt: z.string().optional() }),
  ColumnType,
);
export type Column = z.infer<typeof Column>;

/**
 * Returns the stored enum options merged with the options that an Agent wrote. A matching `id` or
 * label keeps its id, and a new label gets a new id. A stored option that the Agent left out is
 * Archived.
 */
export function mergeEnumOptions(
  stored: EnumOption[],
  specs: EnumOptionSpec[],
  now: string,
): EnumOption[] {
  let next = stored.length + 1;
  const kept = specs.map((spec): EnumOption => {
    const match =
      stored.find((o) => o.id === spec.id) ?? stored.find((o) => o.label === spec.label);
    const option = { id: match?.id ?? `o${next++}`, label: spec.label };
    return spec.color === undefined ? option : { ...option, color: spec.color };
  });
  const keptIds = new Set(kept.map((o) => o.id));
  const archived = stored
    .filter((o) => !keptIds.has(o.id))
    .map((o) => ({ ...o, archivedAt: o.archivedAt ?? now }));
  return [...kept, ...archived];
}

/**
 * Returns the stored form of a parsed column type. Enum options keep their ids from `previous`, and
 * new options get new ids.
 */
export function storedType(
  parsed: ParsedColumnType,
  now: string,
  previous?: ColumnType,
): ColumnType {
  if (parsed.type !== "enum") return parsed;
  const stored = previous?.type === "enum" ? previous.options : [];
  return { type: "enum", options: mergeEnumOptions(stored, parsed.options, now) };
}
