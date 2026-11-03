import { Hono } from "hono";
import { Projection, type Storage, StorageError } from "./storage/storage.ts";

type Widget = ReturnType<Storage["dashboard"]>["widgets"][number];

/** Describes a Widget as the web UI draws it, with the rows its Projection reads. */
export interface WidgetView extends Omit<Widget, "children"> {
  /** The rows of the Projection. It is missing if the Widget has no Projection or is broken. */
  result?: ReturnType<Storage["query"]>;
  children: WidgetView[];
}

/** Describes a Dashboard as the web UI draws it. */
export interface DashboardView extends Omit<ReturnType<Storage["dashboard"]>, "widgets"> {
  widgets: WidgetView[];
}

/** Describes the sidebar entry of a Dashboard. */
export type DashboardSummary = ReturnType<Storage["tree"]>[number];

function widgetView(storage: Storage, widget: Widget): WidgetView {
  const children = widget.children.map((child) => widgetView(storage, child));
  if (widget.projection === null || widget.broken) return { ...widget, children };
  return { ...widget, result: storage.query(Projection.parse(widget.projection)), children };
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
