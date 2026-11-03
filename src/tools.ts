import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { ZodError, z } from "zod";
import {
  addChildIssues,
  removeChildIssues,
  slotIssues,
  typeChangeIssues,
  Widget,
  WidgetFields,
} from "./catalog.ts";
import {
  AlterOp,
  ColumnKey,
  ColumnSpec,
  type Issue,
  type Path,
  Projection,
  type Storage,
  StorageError,
} from "./storage/storage.ts";

const Version = z.int().min(1);
const Position = z.union(
  [
    z.enum(["first", "last"]),
    z.strictObject({ before: z.string() }),
    z.strictObject({ after: z.string() }),
  ],
  { error: 'expected "first", "last", { before: id } or { after: id }' },
);
const WidgetParent = z.union([
  z.strictObject({ dashboard: z.string().describe("A Dashboard id or path") }),
  z.strictObject({ widget: z.string().describe("The id of a columns or section Widget") }),
]);
type WidgetParent = z.output<typeof WidgetParent>;

const ItemRef = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["dashboard", "widget", "store"]),
    id: z.string(),
    expectedVersion: Version,
  }),
  z.strictObject({
    kind: z.literal("row"),
    store: z.string(),
    id: z.int(),
    expectedVersion: Version,
  }),
]);
type ItemRef = z.output<typeof ItemRef>;

// The Claude API rejects a request with a tool whose input schema has a union at the top, so
// `item_archive`, `item_restore` and `item_move` list these flat schemas and parse with the unions
// above.
const ItemRefListing = z.strictObject({
  kind: z.enum(["dashboard", "widget", "store", "row"]),
  id: z.union([z.string(), z.int()]).describe("A row id is a number. Every other id is a string."),
  store: z.string().optional().describe("The Data Store of a row"),
  expectedVersion: Version,
});

const MoveFields = { id: z.string(), expectedVersion: Version, position: Position.optional() };
const Move = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("dashboard"), parent: z.string().nullable(), ...MoveFields }),
  z.strictObject({ kind: z.literal("widget"), parent: WidgetParent, ...MoveFields }),
]);
type Move = z.output<typeof Move>;

const MoveListing = z.strictObject({
  kind: z.enum(["dashboard", "widget"]),
  parent: z
    .union([z.string(), z.null(), WidgetParent])
    .describe(
      "For a Dashboard: the id or path of the new parent, or null to make it an Area. For a Widget: { dashboard } or { widget }.",
    ),
  ...MoveFields,
});

/** Returns `schema` for the tool listing, with a validation that accepts any input. */
function unvalidated(schema: z.ZodType): StandardSchemaWithJSON {
  return { "~standard": { ...schema["~standard"], validate: (value: unknown) => ({ value }) } };
}

function validValuesOf(issue: z.core.$ZodIssue): string[] | undefined {
  if (issue.code === "invalid_value") return issue.values.map(String);
  if (issue.code === "invalid_union") {
    const values = issue.errors.flat().flatMap((i) => validValuesOf(i) ?? []);
    return "options" in issue ? issue.options.map(String) : values.length > 0 ? values : undefined;
  }
  return undefined;
}

function issuesOf(error: ZodError): Issue[] {
  return error.issues.map((issue) => {
    const validValues = validValuesOf(issue);
    return {
      path: issue.path.map((p) => (typeof p === "number" ? p : String(p))),
      problem: issue.message,
      ...(issue.code === "invalid_type" && { expected: issue.expected }),
      ...(validValues && { validValues }),
    };
  });
}

function toolResult(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError && { isError }) };
}

/** Returns the error envelope for a failure an Agent can correct. Throws any other error again. */
function errorResult(error: unknown): CallToolResult {
  if (error instanceof ZodError) {
    const issues = issuesOf(error);
    return toolResult({ code: "invalid", message: "The input is invalid", issues }, true);
  }
  if (!(error instanceof StorageError)) throw error;
  const { issues = [], ...rest } = error.details;
  return toolResult({ code: error.code, message: error.message, issues, ...rest }, true);
}

function assertNoIssues(issues: Issue[]): void {
  if (issues.length > 0) throw new StorageError("invalid", "The Widget is invalid", { issues });
}

/** Returns the problems of a Widget subtree that its schema cannot see: Slots and links. */
function widgetIssues(storage: Storage, widget: Widget | WidgetFields, path: Path): Issue[] {
  const children =
    "children" in widget
      ? widget.children.flatMap((child, i) =>
          widgetIssues(storage, child, [...path, "children", i]),
        )
      : [];
  return [...dataIssues(storage, widget, path), ...children];
}

function dataIssues(storage: Storage, widget: Widget | WidgetFields, path: Path): Issue[] {
  if (widget.type === "dashboardLink") {
    const isLive = storage.tree().some((d) => d.id === widget.config.dashboardId);
    return isLive
      ? []
      : [{ path: [...path, "config", "dashboardId"], problem: "no live Dashboard has this id" }];
  }
  if (!("projection" in widget) || widget.projection === undefined) return [];
  const result = storage.projectionColumns(widget.projection, [...path, "projection"]);
  return "issues" in result ? result.issues : slotIssues(widget, result.columns, path);
}

function addIssues(storage: Storage, parent: WidgetParent): Issue[] {
  return "widget" in parent
    ? addChildIssues(storage.widget(parent.widget), ["parent", "widget"])
    : [];
}

/** Returns the problems of taking the live Widget with the id out of the Widget that holds it. */
function removeIssues(storage: Storage, id: string): Issue[] {
  const holder = storage.parentWidget(id);
  return holder?.children.some((c) => c.id === id) ? removeChildIssues(holder, ["id"]) : [];
}

/** Returns the problems of putting the Archived Widget with the id back into its holder. */
function restoreIssues(storage: Storage, id: string): Issue[] {
  const holder = storage.parentWidget(id);
  return holder && !holder.children.some((c) => c.id === id) ? addChildIssues(holder, ["id"]) : [];
}

/**
 * Moves a Dashboard or a Widget. Throws `StorageError` `invalid` if a `columns` Widget would end up
 * with fewer than 2 or more than 4 children.
 */
function moveItem(storage: Storage, input: Move): unknown {
  if (input.kind === "dashboard") return storage.moveDashboard(input);
  // Storage calls are synchronous, so no other tool call can change the holders between these
  // checks and the write.
  const from = storage.parentWidget(input.id)?.id;
  const to = "widget" in input.parent ? input.parent.widget : undefined;
  if (from !== to) {
    const holder = to === undefined ? undefined : storage.widget(to);
    assertNoIssues([
      ...removeIssues(storage, input.id),
      ...(holder ? addChildIssues(holder, ["parent", "widget"]) : []),
    ]);
  }
  return storage.moveWidget(input);
}

function archiveItem(storage: Storage, ref: ItemRef): unknown {
  switch (ref.kind) {
    case "row":
      return storage.archiveRow(ref);
    case "dashboard":
      return storage.archiveDashboard(ref);
    case "widget":
      assertNoIssues(removeIssues(storage, ref.id));
      return storage.archiveWidget(ref);
    case "store":
      return storage.archiveStore(ref);
  }
}

function restoreItem(storage: Storage, ref: ItemRef): unknown {
  switch (ref.kind) {
    case "row":
      return storage.restoreRow(ref);
    case "dashboard":
      return storage.restoreDashboard(ref);
    case "widget":
      assertNoIssues(restoreIssues(storage, ref.id));
      return storage.restoreWidget(ref);
    case "store":
      return storage.restoreStore(ref);
  }
}

const widgetExamples = `Examples, one per type:
{"type":"kpi","title":"Weight","config":{"goodDirection":"down"},"projection":{"from":"weight","select":[{"column":"day"},{"column":"kg"}],"sort":[{"column":"day"}],"slots":{"x":"day","y":"kg"}}}
{"type":"chart","title":"Spending by month","config":{"mark":"bar","stacked":true},"projection":{"from":"expenses","groupBy":[{"column":"date","bucket":"month","as":"month"},{"column":"category"}],"aggregate":[{"op":"sum","column":"amount","as":"total"}],"sort":[{"column":"month"}],"slots":{"x":"month","y":"total","series":"category"}}}
{"type":"table","title":"Recent expenses","config":{},"projection":{"from":"expenses","sort":[{"column":"date","desc":true}],"limit":20}}
{"type":"progress","title":"Budget","config":{"goodDirection":"down"},"projection":{"from":"budget","select":[{"column":"category"},{"column":"spent"},{"column":"limit"}],"slots":{"label":"category","value":"spent","target":"limit"}}}
{"type":"checklist","title":"This week","config":{"items":[{"text":"Book the dentist","done":false,"due":"2026-11-06"}]}}
{"type":"note","title":"Tips","config":{"markdown":"Drink water **before** the run."}}
{"type":"dashboardLink","config":{"dashboardId":"d_..."}}
{"type":"columns","config":{},"children":[{"type":"note","config":{"markdown":"left"}},{"type":"note","config":{"markdown":"right"}}]}
{"type":"section","title":"Running","config":{},"children":[]}`;

/**
 * The annotations of each kind of tool. A client may retry an idempotent call that lost its
 * connection, and a retried call with `expectedVersion` gets `conflict` instead of applying twice.
 */
const effects = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  versioned: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  overwrite: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
} satisfies Record<string, ToolAnnotations>;

/** Lets Claude Code return a result of up to 500,000 characters inline instead of in a file. */
const largeResult = { "anthropic/maxResultSizeChars": 500_000 };

interface ToolSpec<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  effect: keyof typeof effects;
  input: S;
  /** A flat schema to list instead of `input`, whose top-level union the Claude API rejects. */
  listing?: z.ZodType;
  meta?: Record<string, unknown>;
  run: (args: z.output<S>) => unknown;
}

/** Registers the tools that Agents read and write Dashboards, Widgets and Data Stores with. */
export function registerTools(server: McpServer, storage: Storage): void {
  const tool = <S extends z.ZodType>(spec: ToolSpec<S>) =>
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: unvalidated(spec.listing ?? spec.input),
        annotations: { ...effects[spec.effect], openWorldHint: false },
        ...(spec.meta && { _meta: spec.meta }),
      },
      (args: unknown) => {
        try {
          return toolResult(spec.run(spec.input.parse(args)));
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  const noInput = z.strictObject({});

  tool({
    name: "dashboard_tree",
    title: "List Dashboards",
    description:
      "Lists every live Dashboard as a flat list with its id, path, title and parent, and the counts of its Widgets, child Dashboards and broken Widgets. Call it first in a session to see what exists before you create anything. Use a path or id from it to call dashboard_get.",
    effect: "read",
    input: noInput,
    run: () => storage.tree(),
  });
  tool({
    name: "dashboard_get",
    title: "Get a Dashboard",
    description:
      "Returns one Dashboard with its full Widget tree, each Widget's id, version, config and Projection. Use it before you change or add Widgets, and after a call that got no reply. A Widget that cannot read its Data Stores carries `broken` with the reason.",
    effect: "read",
    input: z.strictObject({
      dashboard: z.string().describe("A Dashboard id or path such as finance/budget"),
    }),
    meta: largeResult,
    run: ({ dashboard }) => storage.dashboard(dashboard),
  });
  tool({
    name: "store_list",
    title: "List Data Stores",
    description:
      "Lists every live Data Store with its id, version, columns, Key, row count and the Widgets that read it. Use it to find a Data Store to append rows to or to bind a Widget to. It returns no rows: read them with projection_query.",
    effect: "read",
    input: noInput,
    run: () => storage.stores(),
  });
  tool({
    name: "archive_list",
    title: "List Archived items",
    description:
      "Lists the Archived Dashboards, Widgets and Data Stores. With `store`, lists the Archived rows and columns of that Data Store instead. Use it to find something to bring back with restore.",
    effect: "read",
    input: z.strictObject({ store: z.string().optional() }),
    run: ({ store }) =>
      store === undefined
        ? storage.archived()
        : { rows: storage.archivedRows(store), columns: storage.store(store).archivedColumns },
  });
  tool({
    name: "projection_query",
    title: "Query Data Stores",
    description:
      "Runs a Projection over the Data Stores and returns `{ columns, rows, truncated }`. Use it to read rows, and to try a Projection before you bind a Widget to it. It returns at most `limit` rows (default 100, max 1,000), and `truncated` is true if there are more.",
    effect: "read",
    input: z.strictObject({ projection: Projection }),
    meta: largeResult,
    run: ({ projection }) => storage.query(projection),
  });

  tool({
    name: "dashboard_create",
    title: "Create a Dashboard",
    description:
      "Creates a Dashboard under `parent`, or an Area (a top-level Dashboard such as Finance) without one. The slug comes from the title unless given, and a taken slug fails with `conflict` and returns the existing Dashboard. Returns the new Dashboard with its id, path and version.",
    effect: "create",
    input: z.strictObject({
      parent: z.string().optional().describe("A Dashboard id or path"),
      title: z.string().min(1),
      slug: z.string().optional(),
      icon: z.string().optional(),
      description: z.string().optional(),
      position: Position.optional(),
    }),
    run: (input) => storage.createDashboard(input),
  });
  tool({
    name: "dashboard_update",
    title: "Update a Dashboard",
    description:
      "Changes the given fields of a Dashboard and keeps the others. A new title keeps the old slug, so the path changes only with a new slug. Use item_move to put it under another parent. Returns the Dashboard with its new version.",
    effect: "overwrite",
    input: z.strictObject({
      dashboard: z.string().describe("A Dashboard id or path"),
      expectedVersion: Version,
      title: z.string().min(1).optional(),
      slug: z.string().optional(),
      icon: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
    run: ({ dashboard, ...rest }) => storage.updateDashboard({ id: dashboard, ...rest }),
  });

  tool({
    name: "widget_add",
    title: "Add a Widget",
    description: `Adds a Widget with its whole subtree to a Dashboard or to a columns or section Widget. Data Widgets read a Data Store through \`projection\`, whose \`slots\` name output columns. A retried call adds a second Widget, so after a call with no reply, check with dashboard_get first. Returns the Widget tree with ids and versions.\n${widgetExamples}`,
    effect: "create",
    input: z.strictObject({ parent: WidgetParent, widget: Widget, position: Position.optional() }),
    run: (input) => {
      assertNoIssues([
        ...addIssues(storage, input.parent),
        ...widgetIssues(storage, input.widget, ["widget"]),
      ]);
      return storage.addWidget(input);
    },
  });
  tool({
    name: "widget_update",
    title: "Update a Widget",
    description:
      "Replaces the title, config and Projection of a Widget. Its type and children stay, so send the whole Widget as dashboard_get returned it with your changes. Returns the Widget with its new version.",
    effect: "overwrite",
    input: z.strictObject({ id: z.string(), expectedVersion: Version, widget: WidgetFields }),
    run: ({ id, expectedVersion, widget }) => {
      assertNoIssues([
        ...typeChangeIssues(storage.widget(id).type, widget.type),
        ...widgetIssues(storage, widget, ["widget"]),
      ]);
      const { title, config } = widget;
      return storage.updateWidget({
        id,
        expectedVersion,
        title,
        config,
        projection: "projection" in widget ? widget.projection : undefined,
      });
    },
  });

  tool({
    name: "store_create",
    title: "Create a Data Store",
    description:
      "Creates a Data Store, a table for numbers and records that Widgets read. Column types: text, number (format, unit), money (currency), date, datetime (timezone), boolean, enum (options). Give it a Key when rows have a natural identity, such as the date of a weight log, so a retried append cannot add a row twice. A taken name fails with `conflict` and returns the existing Data Store.",
    effect: "create",
    input: z.strictObject({
      name: z.string().min(1),
      columns: z.array(ColumnSpec).min(1),
      key: z.array(ColumnKey).optional(),
    }),
    run: (input) => storage.createStore(input),
  });
  tool({
    name: "store_alter",
    title: "Alter a Data Store",
    description:
      "Applies ops to the columns and Key of a Data Store in order, all or none: add, rename, retype, archive or restore a column, set the Key, or set enum options. A retype rewrites existing values. With `dryRun`, it reports unconvertible values and Key duplicates and changes nothing. Returns the Data Store with its new version.",
    effect: "overwrite",
    input: z.strictObject({
      store: z.string(),
      expectedVersion: Version,
      ops: z.array(AlterOp).min(1),
      dryRun: z.boolean().optional(),
    }),
    run: (input) => storage.alterStore(input),
  });

  tool({
    name: "rows_append",
    title: "Append rows",
    description:
      "Appends up to 1,000 rows to a Data Store, all or none, each row an object keyed by column key. If a row's Key matches a live row, `onConflict` decides: error (default), update or skip. Without a Key, a retried call appends the rows again. Returns the ids of the inserted, updated and skipped rows.",
    effect: "create",
    input: z.strictObject({
      store: z.string(),
      rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
      onConflict: z.enum(["error", "update", "skip"]).optional(),
    }),
    run: (input) => storage.appendRows(input),
  });
  tool({
    name: "rows_update",
    title: "Update rows",
    description:
      'Writes the given values of up to 1,000 rows by id, all or none, and keeps the other columns. Row ids come from rows_append. To change a row of a Data Store with a Key, rows_append with onConflict "update" needs no id or version. Returns the rows with their new versions.',
    effect: "overwrite",
    input: z.strictObject({
      store: z.string(),
      rows: z
        .array(
          z.strictObject({
            id: z.int(),
            expectedVersion: Version,
            values: z.record(z.string(), z.unknown()),
          }),
        )
        .min(1)
        .max(1000),
    }),
    run: (input) => storage.updateRows(input),
  });

  tool({
    name: "item_move",
    title: "Move a Dashboard or Widget",
    description:
      "Moves a Dashboard under another one, or makes it an Area with a null parent. Moves a Widget with its subtree to a Dashboard or into a columns or section Widget. `position` orders it among its new siblings. Returns the moved item with its new version.",
    effect: "versioned",
    input: Move,
    listing: MoveListing,
    run: (input) => moveItem(storage, input),
  });
  tool({
    name: "item_archive",
    title: "Archive an item",
    description:
      "Archives a Dashboard, Widget, Data Store or row, which hides it and everything under it. Nothing is deleted: item_restore brings it back. Returns the Archived item.",
    effect: "versioned",
    input: ItemRef,
    listing: ItemRefListing,
    run: (ref) => archiveItem(storage, ref),
  });
  tool({
    name: "item_restore",
    title: "Restore an item",
    description:
      "Restores an Archived Dashboard, Widget, Data Store or row with what was under it. Find Archived items with archive_list. Returns the restored item.",
    effect: "versioned",
    input: ItemRef,
    listing: ItemRefListing,
    run: (ref) => restoreItem(storage, ref),
  });
}
