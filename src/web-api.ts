import { Hono } from "hono";
import { WidgetFields } from "./catalog.ts";
import { type Storage, StorageError } from "./storage/storage.ts";

type StoredWidget = ReturnType<Storage["dashboard"]>["widgets"][number];

/** Describes the live Dashboard that a `dashboardLink` Widget points at. */
export type LinkTarget = Pick<
  ReturnType<Storage["dashboard"]>,
  "path" | "title" | "icon" | "description"
>;

/**
 * Describes a Widget as the web UI draws it. `result` holds the rows of its Projection and is
 * missing if the Widget has no Projection or is broken. `target` is missing if the Dashboard that a
 * `dashboardLink` points at is not live.
 */
export type WidgetView = WidgetFields & {
  id: string;
  updatedAt: string;
  broken?: NonNullable<StoredWidget["broken"]>;
  result?: ReturnType<Storage["query"]>;
  target?: LinkTarget;
  children: WidgetView[];
};

/** Describes a Dashboard as the web UI draws it. */
export interface DashboardView extends Omit<ReturnType<Storage["dashboard"]>, "widgets"> {
  widgets: WidgetView[];
}

/** Describes the sidebar entry of a Dashboard. */
export type DashboardSummary = ReturnType<Storage["tree"]>[number];

function linkTarget(storage: Storage, id: string): { target?: LinkTarget } {
  try {
    const { path, title, icon, description } = storage.dashboard(id);
    return { target: { path, title, icon, description } };
  } catch (error) {
    if (error instanceof StorageError) return {};
    throw error;
  }
}

function widgetView(storage: Storage, widget: StoredWidget): WidgetView {
  const { id, type, title, config, projection, broken, updatedAt } = widget;
  const fields = WidgetFields.parse({
    type,
    title: title ?? undefined,
    config,
    ...(projection !== null && { projection }),
  });
  const view: WidgetView = {
    ...fields,
    id,
    updatedAt,
    ...(broken && { broken }),
    children: widget.children.map((child) => widgetView(storage, child)),
  };
  if (fields.type === "dashboardLink") {
    return { ...view, ...linkTarget(storage, fields.config.dashboardId) };
  }
  if (!("projection" in fields) || fields.projection === undefined || broken) return view;
  return { ...view, result: storage.query(fields.projection) };
}

/**
 * Creates the read-only HTTP routes of the web UI: `GET /tree` and `GET /dashboards/<path>`. A
 * missing or Archived Dashboard answers 404.
 */
export function createWebApi(storage: Storage) {
  const api = new Hono();
  api.get("/tree", (c) => c.json(storage.tree()));
  api.get("/dashboards/:path{.+}", (c) => {
    const dashboard = storage.dashboard(c.req.param("path"));
    const view: DashboardView = {
      ...dashboard,
      widgets: dashboard.widgets.map((w) => widgetView(storage, w)),
    };
    return c.json(view);
  });
  api.onError((error, c) => {
    if (error instanceof StorageError && ["not_found", "archived"].includes(error.code)) {
      return c.json({ error: error.message }, 404);
    }
    throw error;
  });
  api.notFound((c) => c.json({ error: "Not found" }, 404));
  return api;
}
