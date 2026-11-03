import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
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

// MCP clients reject a tool whose input schema has a union at the top, so `archive`, `restore` and
// `move` list these flat schemas and parse with the unions above.
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

/** Registers the tools that Agents read and write Dashboards, Widgets and Data Stores with. */
export function registerTools(server: McpServer, storage: Storage): void {
  const tool = <S extends z.ZodType>(
    name: string,
    description: string,
    input: S,
    run: (args: z.output<S>) => unknown,
    options: { isReadOnly?: boolean; listing?: z.ZodType } = {},
  ) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema: unvalidated(options.listing ?? input),
        annotations: { readOnlyHint: options.isReadOnly ?? false },
      },
      (args: unknown) => {
        try {
          return toolResult(run(input.parse(args)));
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  const noInput = z.strictObject({});
  const readOnly = { isReadOnly: true };

  tool(
    "get_tree",
    "Lists every live Dashboard with its path and its Widget, child and broken-Widget counts.",
    noInput,
    () => storage.tree(),
    readOnly,
  );
  tool(
    "get_dashboard",
    "Returns a Dashboard with its full Widget tree, configs and Projections. A Widget that cannot read its Data Stores has `broken`.",
    z.strictObject({
      dashboard: z.string().describe("A Dashboard id or path such as finance/budget"),
    }),
    ({ dashboard }) => storage.dashboard(dashboard),
    readOnly,
  );
  tool(
    "list_stores",
    "Lists every live Data Store with its columns, Key, row count and the Widgets that read it.",
    noInput,
    () => storage.stores(),
    readOnly,
  );
  tool(
    "list_archived",
    "Lists the Archived Dashboards, Widgets and Data Stores. With `store`, lists the Archived rows and columns of that Data Store.",
    z.strictObject({ store: z.string().optional() }),
    ({ store }) =>
      store === undefined
        ? storage.archived()
        : { rows: storage.archivedRows(store), columns: storage.store(store).archivedColumns },
    readOnly,
  );
  tool(
    "query",
    "Runs a Projection and returns its columns and rows, at most `limit` (default 100, max 1,000). `truncated` is true if there are more.",
    z.strictObject({ projection: Projection }),
    ({ projection }) => storage.query(projection),
    readOnly,
  );

  tool(
    "dashboard_create",
    "Creates a Dashboard under `parent`, or an Area without one. The slug comes from the title unless given.",
    z.strictObject({
      parent: z.string().optional().describe("A Dashboard id or path"),
      title: z.string().min(1),
      slug: z.string().optional(),
      icon: z.string().optional(),
      description: z.string().optional(),
      position: Position.optional(),
    }),
    (input) => storage.createDashboard(input),
  );
  tool(
    "dashboard_update",
    "Changes the given fields of a Dashboard. A new title keeps the old slug.",
    z.strictObject({
      dashboard: z.string().describe("A Dashboard id or path"),
      expectedVersion: Version,
      title: z.string().min(1).optional(),
      slug: z.string().optional(),
      icon: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
    ({ dashboard, ...rest }) => storage.updateDashboard({ id: dashboard, ...rest }),
  );

  tool(
    "widget_add",
    `Adds a Widget with its whole subtree to a Dashboard or to a columns or section Widget. Data Widgets read a Data Store through \`projection\`, whose \`slots\` name output columns.\n${widgetExamples}`,
    z.strictObject({ parent: WidgetParent, widget: Widget, position: Position.optional() }),
    (input) => {
      assertNoIssues([
        ...addIssues(storage, input.parent),
        ...widgetIssues(storage, input.widget, ["widget"]),
      ]);
      return storage.addWidget(input);
    },
  );
  tool(
    "widget_update",
    "Replaces the title, config and Projection of a Widget. Its type and children stay.",
    z.strictObject({ id: z.string(), expectedVersion: Version, widget: WidgetFields }),
    ({ id, expectedVersion, widget }) => {
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
  );

  tool(
    "store_create",
    "Creates a Data Store. Column types: text, number (format, unit), money (currency), date, datetime (timezone), boolean, enum (options).",
    z.strictObject({
      name: z.string().min(1),
      columns: z.array(ColumnSpec).min(1),
      key: z.array(ColumnKey).optional(),
    }),
    (input) => storage.createStore(input),
  );
  tool(
    "store_alter",
    "Applies ops to a Data Store in order, all or none. With `dryRun`, reports unconvertible values and Key duplicates and changes nothing.",
    z.strictObject({
      store: z.string(),
      expectedVersion: Version,
      ops: z.array(AlterOp).min(1),
      dryRun: z.boolean().optional(),
    }),
    (input) => storage.alterStore(input),
  );

  tool(
    "rows_append",
    "Appends up to 1,000 rows, keyed by column key, all or none. If a row's Key matches a live row, `onConflict` decides: error (default), update or skip.",
    z.strictObject({
      store: z.string(),
      rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
      onConflict: z.enum(["error", "update", "skip"]).optional(),
    }),
    (input) => storage.appendRows(input),
  );
  tool(
    "rows_update",
    "Writes the given values of up to 1,000 rows, all or none. Other columns keep their values.",
    z.strictObject({
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
    (input) => storage.updateRows(input),
  );

  tool(
    "move",
    "Moves a Dashboard under another one, or a Widget with its subtree to a Dashboard or layout Widget.",
    Move,
    (input) => moveItem(storage, input),
    { listing: MoveListing },
  );
  tool(
    "archive",
    "Archives a Dashboard, Widget, Data Store or row, which hides everything under it.",
    ItemRef,
    (ref) => archiveItem(storage, ref),
    { listing: ItemRefListing },
  );
  tool(
    "restore",
    "Restores an Archived Dashboard, Widget, Data Store or row.",
    ItemRef,
    (ref) => restoreItem(storage, ref),
    { listing: ItemRefListing },
  );
}
