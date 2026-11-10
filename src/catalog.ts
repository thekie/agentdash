import { z } from "zod";
import {
  Projection as AnyProjection,
  type ColumnType,
  type Issue,
  type Path,
} from "./storage/storage.ts";

// The id puts the Projection schema into `$defs` once, so the tool schemas do not repeat it per type.
const Projection = AnyProjection.meta({ id: "Projection" });
const Title = z.string().min(1);
const GoodDirection = z.enum(["up", "down"]);
const NoConfig = z.strictObject({}).default({});

const Kpi = z.strictObject({
  type: z.literal("kpi"),
  title: Title.optional(),
  config: z.strictObject({ goodDirection: GoodDirection.optional() }).default({}),
  projection: Projection,
});

const Chart = z.strictObject({
  type: z.literal("chart"),
  title: Title.optional(),
  config: z
    .strictObject({
      mark: z.enum(["line", "bar"]),
      stacked: z.boolean().optional(),
      additive: z
        .boolean()
        .optional()
        .describe(
          "The series add up, such as km per sport or balances per account, so the tooltip shows their total. Leave it out for prices, weights or rates. Stacked bars always show a total.",
        ),
    })
    .refine((c) => !c.stacked || c.mark === "bar", {
      message: "only a bar chart can be stacked",
      path: ["stacked"],
    }),
  projection: Projection,
});

const Table = z.strictObject({
  type: z.literal("table"),
  title: Title.optional(),
  config: NoConfig,
  projection: Projection,
});

const Progress = z.strictObject({
  type: z.literal("progress"),
  title: Title.optional(),
  config: z
    .strictObject({
      target: z.number().positive().optional(),
      goodDirection: GoodDirection.optional(),
    })
    .default({}),
  projection: Projection,
});

const ChecklistItem = z.strictObject({
  text: z.string().min(1),
  done: z.boolean(),
  due: z.iso.date().optional(),
});

const Checklist = z
  .strictObject({
    type: z.literal("checklist"),
    title: Title.optional(),
    config: z
      .strictObject({
        items: z.array(ChecklistItem).optional(),
        done: z.enum(["strike", "hide"]).optional(),
      })
      .default({}),
    projection: Projection.optional(),
  })
  .refine((w) => w.projection !== undefined || w.config.items !== undefined, {
    message: "a checklist needs config.items or a projection",
    path: ["config", "items"],
  });

const Note = z.strictObject({
  type: z.literal("note"),
  title: Title.optional(),
  config: z.strictObject({ markdown: z.string() }),
});

const DashboardLink = z.strictObject({
  type: z.literal("dashboardLink"),
  title: Title.optional(),
  config: z.strictObject({ dashboardId: z.string().min(1) }),
});

const ColumnsFields = z.strictObject({
  type: z.literal("columns"),
  title: Title.optional(),
  config: NoConfig,
});
const SectionFields = z.strictObject({
  type: z.literal("section"),
  title: Title,
  config: NoConfig,
});

const layoutTypes = ["columns", "section"] as const;
type LayoutType = (typeof layoutTypes)[number];

const maxColumns = 4;
const minColumns = 2;

const leafTypes = [Kpi, Chart, Table, Progress, Checklist, Note, DashboardLink] as const;

/**
 * The schema of a Widget without its children, as `widget_update` replaces it. The type picks the
 * schema of `config` and whether a Projection is required.
 */
export const WidgetFields = z.discriminatedUnion("type", [
  ...leafTypes,
  ColumnsFields,
  SectionFields,
]);
export type WidgetFields = z.output<typeof WidgetFields>;

export type Widget = Exclude<WidgetFields, { type: LayoutType }> | LayoutWidget;

interface LayoutWidget {
  type: LayoutType;
  title?: string | undefined;
  config: Record<string, never>;
  children: Widget[];
}

/**
 * The schema of a Widget from the Widget Catalog with its subtree, as `widget_add` writes it. Only
 * `columns` and `section` hold children, and `columns` holds 2 to 4.
 */
export const Widget: z.ZodType<Widget, unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    ...leafTypes,
    ColumnsFields.extend({ children: z.array(Widget).min(minColumns).max(maxColumns) }),
    SectionFields.extend({ children: z.array(Widget).default([]) }),
  ]),
);

/** Describes a stored Widget that holds or can hold other Widgets. */
interface Holder {
  type: string;
  children: unknown[];
}

/** Returns the problems of putting one more child Widget into `holder`. */
export function addChildIssues(holder: Holder, path: Path): Issue[] {
  if (!layoutTypes.some((t) => t === holder.type)) {
    return [
      {
        path,
        problem: `a ${holder.type} Widget holds no children`,
        expected: "a columns or section Widget",
      },
    ];
  }
  return holder.type === "columns" && holder.children.length >= maxColumns
    ? [{ path, problem: `a columns Widget holds at most ${maxColumns} children` }]
    : [];
}

/** Returns the problems of taking one child Widget out of `holder`. */
export function removeChildIssues(holder: Holder, path: Path): Issue[] {
  return holder.type === "columns" && holder.children.length <= minColumns
    ? [{ path, problem: `a columns Widget holds at least ${minColumns} children` }]
    : [];
}

/** Returns the problem of writing a Widget of type `type` over a stored Widget of `storedType`. */
export function typeChangeIssues(storedType: string, type: string): Issue[] {
  return storedType === type
    ? []
    : [{ path: ["widget", "type"], problem: "the type cannot change", validValues: [storedType] }];
}

type TypeName = ColumnType["type"];

interface SlotRule {
  types: TypeName[];
  isRequired?: boolean;
  /** Is true if the Slot takes a list of columns. */
  isList?: boolean;
}

const numeric: TypeName[] = ["number", "money"];
const time: TypeName[] = ["date", "datetime"];

const slotRules: Partial<Record<WidgetFields["type"], Record<string, SlotRule>>> = {
  kpi: { y: { types: numeric, isRequired: true }, x: { types: time } },
  chart: {
    x: { types: [...time, "text", "enum"], isRequired: true },
    y: { types: numeric, isRequired: true, isList: true },
    series: { types: ["text", "enum"] },
  },
  table: {},
  progress: {
    value: { types: numeric, isRequired: true },
    target: { types: numeric },
    label: { types: ["text", "enum"] },
  },
  checklist: {
    label: { types: ["text"], isRequired: true },
    done: { types: ["boolean"], isRequired: true },
    due: { types: ["date"] },
  },
};

interface Output {
  name: string;
  type: ColumnType;
}

function slotValueIssues(
  slot: string,
  rule: SlotRule,
  value: string | string[],
  outputs: Output[],
  path: Path,
): Issue[] {
  const names = typeof value === "string" ? [value] : value;
  if (names.length > 1 && !rule.isList) {
    return [
      { path: [...path, slot], problem: "the Slot takes one column", expected: "a column name" },
    ];
  }
  return names.flatMap((name, index) => {
    const type = outputs.find((o) => o.name === name)?.type.type;
    if (type === undefined || rule.types.includes(type)) return [];
    const at = typeof value === "string" ? [...path, slot] : [...path, slot, index];
    return [
      { path: at, problem: `column "${name}" is ${type}`, expected: rule.types.join(" or ") },
    ];
  });
}

/** Returns a key that two columns share if a chart can draw them on one axis. */
function axisOf(type: ColumnType): string {
  if (type.type === "money") return `money ${type.currency}`;
  return type.type === "number" ? `number ${type.format} ${type.unit ?? ""}` : type.type;
}

function chartIssues(
  slots: Record<string, string | string[]>,
  outputs: Output[],
  path: Path,
): Issue[] {
  const ys = typeof slots.y === "string" ? [slots.y] : (slots.y ?? []);
  const issues: Issue[] = [];
  if (ys.length > 1 && slots.series !== undefined) {
    issues.push({
      path: [...path, "series"],
      problem: "a chart with several y columns cannot also have series",
    });
  }
  const axes = new Set(
    ys.flatMap((name) => outputs.filter((o) => o.name === name).map((o) => axisOf(o.type))),
  );
  if (axes.size > 1) {
    issues.push({ path: [...path, "y"], problem: "the y columns must share one type and unit" });
  }
  return issues;
}

/**
 * Returns the problems of the Slots of a data Widget, given the output columns of its Projection.
 * `path` points at the Widget.
 */
export function slotIssues(widget: WidgetFields, outputs: Output[], path: Path): Issue[] {
  const rules = slotRules[widget.type];
  if (!rules || !("projection" in widget) || widget.projection === undefined) return [];
  const slots = widget.projection.slots ?? {};
  const slotsPath = [...path, "projection", "slots"];
  const issues = Object.entries(slots).flatMap(([slot, value]) => {
    const rule = rules[slot];
    if (rule) return slotValueIssues(slot, rule, value, outputs, slotsPath);
    return [
      { path: [...slotsPath, slot], problem: "unknown Slot", validValues: Object.keys(rules) },
    ];
  });
  for (const [slot, rule] of Object.entries(rules)) {
    if (rule.isRequired && slots[slot] === undefined) {
      issues.push({
        path: [...slotsPath, slot],
        problem: "missing Slot",
        expected: rule.types.join(" or "),
      });
    }
  }
  if (widget.type === "chart") issues.push(...chartIssues(slots, outputs, slotsPath));
  if (
    widget.type === "progress" &&
    slots.target === undefined &&
    widget.config.target === undefined
  ) {
    issues.push({
      path: [...path, "config", "target"],
      problem: "a progress Widget needs a target Slot or config.target",
    });
  }
  return issues;
}
