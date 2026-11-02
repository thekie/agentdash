import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { ZodError, z } from "zod";
import { layoutTypes, maxColumns, slotIssues, Widget, WidgetFields } from "./catalog.ts";
import { ColumnKey, ColumnSpec } from "./storage/columns.ts";
import { type Issue, type Path, StorageError } from "./storage/errors.ts";
import { Projection } from "./storage/projection.ts";
import type { Storage } from "./storage/storage.ts";
import { AlterOp } from "./storage/stores.ts";

const Version = z.int().min(1);
const Position = z.union([
  z.enum(["first", "last"]),
  z.strictObject({ before: z.string() }),
  z.strictObject({ after: z.string() }),
]);
const WidgetParent = z.union([
  z.strictObject({ dashboard: z.string().describe("A Dashboard id or path") }),
  z.strictObject({ widget: z.string().describe("The id of a columns or section Widget") }),
]);
const Kind = z.enum(["dashboard", "widget", "store", "row"]);
const ItemRef = z.strictObject({
  kind: Kind,
  id: z.union([z.string(), z.int()]).describe("A row id is a number. Every other id is a string."),
  store: z.string().optional().describe("The Data Store of a row"),
  expectedVersion: Version,
});

/**
 * Returns `schema` with a validation that accepts any input. The tool parses its input itself, so
 * that an invalid call gets the error envelope with its issues.
 */
function unchecked(schema: z.ZodType): StandardSchemaWithJSON {
  return { "~standard": { ...schema["~standard"], validate: (value: unknown) => ({ value }) } };
}

function issuesOf(error: ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => (typeof p === "number" ? p : String(p))),
    problem: issue.message,
    ...("values" in issue && { validValues: issue.values.map(String) }),
    ...("options" in issue && { validValues: issue.options.map(String) }),
  }));
}

function json(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError && { isError }) };
}

/** Returns the error envelope for a failure an Agent can correct. Throws any other error again. */
function failure(error: unknown): CallToolResult {
  if (error instanceof ZodError) {
    return json(
      { code: "invalid", message: "The input is invalid", issues: issuesOf(error) },
      true,
    );
  }
  if (!(error instanceof StorageError)) throw error;
  const { issues = [], ...rest } = error.details;
  return json({ code: error.code, message: error.message, issues, ...rest }, true);
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
  return [...ownIssues(storage, widget, path), ...children];
}

function ownIssues(storage: Storage, widget: Widget | WidgetFields, path: Path): Issue[] {
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

/** Returns the problems of putting a Widget into `parent`. `moving` is the id of a moved Widget. */
function parentIssues(
  storage: Storage,
  parent: z.output<typeof WidgetParent>,
  moving?: string,
): Issue[] {
  if (!("widget" in parent)) return [];
  const target = storage.widget(parent.widget);
  const path = ["parent", "widget"];
  if (!layoutTypes.has(target.type)) {
    return [
      {
        path,
        problem: `a ${target.type} Widget holds no children`,
        expected: "a columns or section Widget",
      },
    ];
  }
  const others = target.children.filter((c) => c.id !== moving);
  return target.type === "columns" && others.length >= maxColumns
    ? [{ path, problem: `a columns Widget holds at most ${maxColumns} children` }]
    : [];
}

function stringId(ref: z.output<typeof ItemRef>): string {
  if (typeof ref.id === "string") return ref.id;
  throw new StorageError("invalid", `A ${ref.kind} id is a string`, {
    issues: [{ path: ["id"], problem: "expected a string" }],
  });
}

function rowRef(ref: z.output<typeof ItemRef>) {
  if (typeof ref.id === "number" && ref.store !== undefined) {
    return { store: ref.store, id: ref.id, expectedVersion: ref.expectedVersion };
  }
  throw new StorageError("invalid", "A row needs its Data Store and a number id", {
    issues: [
      { path: ref.store === undefined ? ["store"] : ["id"], problem: "missing or wrong type" },
    ],
  });
}

/** Archives or restores the item that `ref` names. */
function setArchived(
  storage: Storage,
  ref: z.output<typeof ItemRef>,
  isArchived: boolean,
): unknown {
  if (ref.kind === "row")
    return isArchived ? storage.archiveRow(rowRef(ref)) : storage.restoreRow(rowRef(ref));
  const input = { id: stringId(ref), expectedVersion: ref.expectedVersion };
  const writes = {
    dashboard: [storage.archiveDashboard, storage.restoreDashboard],
    widget: [storage.archiveWidget, storage.restoreWidget],
    store: [storage.archiveStore, storage.restoreStore],
  } as const;
  const [archive, restore] = writes[ref.kind];
  return (isArchived ? archive : restore)(input);
}

const Move = z.strictObject({
  kind: z.enum(["dashboard", "widget"]),
  id: z.string(),
  expectedVersion: Version,
  parent: z
    .union([z.string(), z.null(), WidgetParent])
    .describe(
      "For a Dashboard: the id or path of the new parent, or null to make it an Area. For a Widget: { dashboard } or { widget }.",
    ),
  position: Position.optional(),
});

function move(storage: Storage, input: z.output<typeof Move>): unknown {
  const { kind, parent, ...rest } = input;
  if (kind === "dashboard") {
    if (typeof parent === "object" && parent !== null) {
      throw new StorageError("invalid", "A Dashboard moves under a Dashboard id or path, or null", {
        issues: [{ path: ["parent"], problem: "expected a string or null" }],
      });
    }
    return storage.moveDashboard({ ...rest, parent });
  }
  if (typeof parent !== "object" || parent === null) {
    throw new StorageError("invalid", "A Widget moves to { dashboard } or { widget }", {
      issues: [{ path: ["parent"], problem: "expected { dashboard } or { widget }" }],
    });
  }
  assertNoIssues(parentIssues(storage, parent, input.id));
  return storage.moveWidget({ ...rest, parent });
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

/** Registers the tools that Agents read and write the Owner's dashboards with. */
export function registerTools(server: McpServer, storage: Storage): void {
  const tool = <S extends z.ZodType>(
    name: string,
    description: string,
    input: S,
    run: (args: z.output<S>) => unknown,
    isReadOnly = false,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: unchecked(input), annotations: { readOnlyHint: isReadOnly } },
      (args: unknown) => {
        try {
          return json(run(input.parse(args)));
        } catch (error) {
          return failure(error);
        }
      },
    );
  const none = z.strictObject({});

  tool(
    "get_tree",
    "Lists every live Dashboard with its path and its Widget, child and broken-Widget counts.",
    none,
    () => storage.tree(),
    true,
  );
  tool(
    "get_dashboard",
    "Returns a Dashboard with its full Widget tree, configs and Projections. A Widget that cannot read its Data Stores has `broken`.",
    z.strictObject({
      dashboard: z.string().describe("A Dashboard id or path such as finance/budget"),
    }),
    ({ dashboard }) => storage.dashboard(dashboard),
    true,
  );
  tool(
    "list_stores",
    "Lists every live Data Store with its columns, Key, row count and the Widgets that read it.",
    none,
    () => storage.stores(),
    true,
  );
  tool(
    "list_archived",
    "Lists the Archived Dashboards, Widgets and Data Stores. With `store`, lists the Archived rows and columns of that Data Store.",
    z.strictObject({ store: z.string().optional() }),
    ({ store }) =>
      store === undefined
        ? storage.archived()
        : { rows: storage.archivedRows(store), columns: storage.store(store).archivedColumns },
    true,
  );
  tool(
    "query",
    "Runs a Projection and returns its columns and rows, at most `limit` (default 100, max 1,000). `truncated` is true if there are more.",
    z.strictObject({ projection: Projection }),
    ({ projection }) => storage.query(projection),
    true,
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
        ...parentIssues(storage, input.parent),
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
      const stored = storage.widget(id);
      if (stored.type !== widget.type) {
        throw new StorageError(
          "invalid",
          `Widget ${id} is a ${stored.type}. Its type cannot change.`,
          {
            issues: [
              {
                path: ["widget", "type"],
                problem: "type cannot change",
                validValues: [stored.type],
              },
            ],
          },
        );
      }
      assertNoIssues(widgetIssues(storage, widget, ["widget"]));
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
    (input) => move(storage, input),
  );
  tool(
    "archive",
    "Archives a Dashboard, Widget, Data Store or row, which hides everything under it.",
    ItemRef,
    (ref) => setArchived(storage, ref, true),
  );
  tool("restore", "Restores an Archived Dashboard, Widget, Data Store or row.", ItemRef, (ref) =>
    setArchived(storage, ref, false),
  );
}
