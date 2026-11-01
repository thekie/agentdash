import { z } from "zod";

const currencies = new Set(Intl.supportedValuesOf("currency"));

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

/** An enum option as an Agent writes it. A known `id` renames that option. */
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
export type EnumOption = z.infer<typeof EnumOption>;

/** A column type as an Agent writes it, in `store_create` and `retype_column`. */
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
export type ParsedColumnType = z.output<typeof ColumnTypeSpec>;

const ColumnBase = z.object({ key: ColumnKey, label: z.string().min(1).optional() });

export const ColumnSpec = z.intersection(ColumnBase, ColumnTypeSpec);
export type ColumnSpec = z.input<typeof ColumnSpec>;
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
export type ColumnType = z.infer<typeof ColumnType>;

/** A column as stored. `physical` names its SQL column and never changes. */
export const Column = z.intersection(
  ColumnBase.extend({ physical: z.string(), archivedAt: z.string().optional() }),
  ColumnType,
);
export type Column = z.infer<typeof Column>;

/**
 * Merges the enum options an Agent wrote into the stored ones: a matching `id` or label keeps its
 * id, a new label gets a fresh id, and a stored option left out is Archived.
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

/** Turns an Agent's column type into the stored form, giving enum options their ids. */
export function storedType(
  parsed: ParsedColumnType,
  now: string,
  previous?: ColumnType,
): ColumnType {
  if (parsed.type !== "enum") return parsed;
  const stored = previous?.type === "enum" ? previous.options : [];
  return { type: "enum", options: mergeEnumOptions(stored, parsed.options, now) };
}
