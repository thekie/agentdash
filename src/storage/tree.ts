import { z } from "zod";
import { createId, type Database } from "./database.ts";
import { assertVersion, StorageError } from "./errors.ts";
import { type Position, placeAt } from "./position.ts";

const DashboardRow = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  ord: z.number(),
  slug: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
type DashboardRow = z.infer<typeof DashboardRow>;

const WidgetRow = z.object({
  id: z.string(),
  dashboardId: z.string().nullable(),
  parentId: z.string().nullable(),
  ord: z.number(),
  type: z.string(),
  title: z.string().nullable(),
  config: z.string().transform((s): unknown => JSON.parse(s)),
  projection: z
    .string()
    .nullable()
    .transform((s): unknown => (s === null ? null : JSON.parse(s))),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
type WidgetRow = z.infer<typeof WidgetRow>;

export interface Dashboard {
  id: string;
  parentId: string | null;
  /** Slugs from the Area down, joined by `/`. Agents may address a Dashboard by it. */
  path: string;
  slug: string;
  title: string;
  icon: string | null;
  description: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface DashboardSummary
  extends Pick<Dashboard, "id" | "parentId" | "path" | "title" | "icon"> {
  widgetCount: number;
  childCount: number;
}

/** A Widget as an Agent writes it, with its whole subtree. `config` and `projection` are JSON. */
export interface WidgetInput {
  type: string;
  title?: string | undefined;
  config: unknown;
  projection?: unknown;
  children?: WidgetInput[] | undefined;
}

export interface Widget {
  id: string;
  type: string;
  title: string | null;
  config: unknown;
  projection: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
  children: Widget[];
}

export interface DashboardWithWidgets extends Dashboard {
  widgets: Widget[];
}

/** Where a Widget sits: directly on a Dashboard (by id or path) or inside a layout Widget. */
export type WidgetParent = { dashboard: string } | { widget: string };

/** Every Dashboard and Widget, read whole on each call. */
interface Tree {
  dashboards: Map<string, DashboardRow>;
  widgets: Map<string, WidgetRow>;
}

function treeOf(db: Database): Tree {
  const dashboards = db.all(DashboardRow, "SELECT * FROM dashboards ORDER BY ord, id");
  const widgets = db.all(WidgetRow, "SELECT * FROM widgets ORDER BY ord, id");
  return {
    dashboards: new Map(dashboards.map((d) => [d.id, d])),
    widgets: new Map(widgets.map((w) => [w.id, w])),
  };
}

function pathOf(tree: Tree, row: DashboardRow): string {
  const parent = row.parentId === null ? undefined : tree.dashboards.get(row.parentId);
  return parent ? `${pathOf(tree, parent)}/${row.slug}` : row.slug;
}

function toDashboard(tree: Tree, row: DashboardRow): Dashboard {
  const { ord: _, ...rest } = row;
  return { ...rest, path: pathOf(tree, row) };
}

function liveChildren(tree: Tree, parentId: string | null): DashboardRow[] {
  return [...tree.dashboards.values()].filter(
    (d) => d.parentId === parentId && d.archivedAt === null,
  );
}

function findDashboard(tree: Tree, ref: string): DashboardRow {
  const byId = tree.dashboards.get(ref);
  if (byId) return byId;
  let found: DashboardRow | undefined;
  for (const slug of ref.split("/")) {
    found = liveChildren(tree, found?.id ?? null).find((d) => d.slug === slug);
    if (!found) break;
  }
  if (!found) throw new StorageError("not_found", `No Dashboard with id or path "${ref}"`);
  return found;
}

function findWidget(tree: Tree, id: string): WidgetRow {
  const found = tree.widgets.get(id);
  if (!found) throw new StorageError("not_found", `No Widget with id "${id}"`);
  return found;
}

/** The nearest Archived Dashboard at or above `row`. */
function archivedDashboardAbove(
  tree: Tree,
  row: DashboardRow | undefined,
): DashboardRow | undefined {
  if (!row || row.archivedAt !== null) return row;
  return archivedDashboardAbove(
    tree,
    row.parentId === null ? undefined : tree.dashboards.get(row.parentId),
  );
}

type Archived = { kind: "Dashboard"; row: DashboardRow } | { kind: "Widget"; row: WidgetRow };

/** The nearest Archived Widget or Dashboard at or above `row`. */
function archivedAbove(tree: Tree, row: WidgetRow): Archived | undefined {
  if (row.archivedAt !== null) return { kind: "Widget", row };
  const parent = row.parentId === null ? undefined : tree.widgets.get(row.parentId);
  if (parent) return archivedAbove(tree, parent);
  const dashboard = archivedDashboardAbove(tree, tree.dashboards.get(row.dashboardId ?? ""));
  return dashboard && { kind: "Dashboard", row: dashboard };
}

function assertNotArchived(archived: Archived | undefined): void {
  if (!archived) return;
  const name = archived.row.title === null ? "" : ` ("${archived.row.title}")`;
  throw new StorageError(
    "archived",
    `${archived.kind} ${archived.row.id}${name} is Archived; restore it first`,
  );
}

function assertDashboardLive(tree: Tree, row: DashboardRow | undefined): void {
  const archived = archivedDashboardAbove(tree, row);
  assertNotArchived(archived && { kind: "Dashboard", row: archived });
}

function placement(siblings: string[], id: string, position: Position): string[] {
  const order = placeAt(siblings, id, position);
  if (order) return order;
  throw new StorageError("invalid", "The position anchor is not a sibling", {
    issues: [{ path: ["position"], problem: "unknown anchor", validValues: siblings }],
  });
}

function writeOrder(db: Database, table: "dashboards" | "widgets", ids: string[]): void {
  for (const [ord, id] of ids.entries())
    db.run(`UPDATE ${table} SET ord = ? WHERE id = ?`, ord, id);
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Lowercase ASCII words joined by `-`, from a title. */
export function slugFrom(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "dashboard";
}

function assertSlugFree(tree: Tree, slug: string, parentId: string | null, self?: string): void {
  if (!slugPattern.test(slug)) {
    throw new StorageError("invalid", `Slug "${slug}" is not lowercase words joined by -`, {
      issues: [{ path: ["slug"], problem: "invalid slug", expected: "such as monthly-budget" }],
    });
  }
  const taken = liveChildren(tree, parentId).find((d) => d.slug === slug && d.id !== self);
  if (taken) {
    throw new StorageError("conflict", `A sibling Dashboard already has the slug "${slug}"`, {
      current: toDashboard(tree, taken),
    });
  }
}

export interface CreateDashboardInput {
  /** The parent Dashboard by id or path. Omit to create an Area. */
  parent?: string | undefined;
  title: string;
  slug?: string | undefined;
  icon?: string | undefined;
  description?: string | undefined;
  position?: Position | undefined;
}

/**
 * Creates a Dashboard, or an Area when there is no parent. The slug defaults to one made from the
 * title. Fails with `conflict` when a sibling has the slug, returning that sibling.
 */
export function createDashboard(db: Database, input: CreateDashboardInput, now: string): Dashboard {
  const tree = treeOf(db);
  const parent = input.parent === undefined ? undefined : findDashboard(tree, input.parent);
  assertDashboardLive(tree, parent);
  const parentId = parent?.id ?? null;
  const slug = input.slug ?? slugFrom(input.title);
  assertSlugFree(tree, slug, parentId);
  const id = createId("d");
  db.run(
    `INSERT INTO dashboards (id, parentId, ord, slug, title, icon, description, createdAt, updatedAt)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    id,
    parentId,
    slug,
    input.title,
    input.icon ?? null,
    input.description ?? null,
    now,
    now,
  );
  const siblings = liveChildren(tree, parentId).map((d) => d.id);
  writeOrder(db, "dashboards", placement(siblings, id, input.position ?? "last"));
  return dashboardById(db, id);
}

function dashboardById(db: Database, id: string): Dashboard {
  const tree = treeOf(db);
  return toDashboard(tree, findDashboard(tree, id));
}

export interface UpdateDashboardInput {
  id: string;
  expectedVersion: number;
  title?: string | undefined;
  slug?: string | undefined;
  icon?: string | null | undefined;
  description?: string | null | undefined;
}

/** Changes the given fields of a Dashboard. A new title keeps the old slug. */
export function updateDashboard(db: Database, input: UpdateDashboardInput, now: string): Dashboard {
  const tree = treeOf(db);
  const row = findDashboard(tree, input.id);
  assertVersion(row, input.expectedVersion, () => toDashboard(tree, row));
  assertDashboardLive(tree, row);
  if (input.slug !== undefined) assertSlugFree(tree, input.slug, row.parentId, row.id);
  const next = {
    title: input.title ?? row.title,
    slug: input.slug ?? row.slug,
    icon: input.icon === undefined ? row.icon : input.icon,
    description: input.description === undefined ? row.description : input.description,
  };
  db.run(
    `UPDATE dashboards SET title = ?, slug = ?, icon = ?, description = ?, version = version + 1,
     updatedAt = ? WHERE id = ?`,
    next.title,
    next.slug,
    next.icon,
    next.description,
    now,
    row.id,
  );
  return dashboardById(db, row.id);
}

function containerKey(row: WidgetRow): string {
  return row.parentId === null ? `d:${row.dashboardId}` : `w:${row.parentId}`;
}

function liveWidgetsIn(tree: Tree, key: string): WidgetRow[] {
  return [...tree.widgets.values()].filter((w) => containerKey(w) === key && w.archivedAt === null);
}

function toWidget(tree: Tree, row: WidgetRow): Widget {
  const { id, type, title, config, projection, version, createdAt, updatedAt } = row;
  const children = liveWidgetsIn(tree, `w:${id}`).map((child) => toWidget(tree, child));
  return { id, type, title, config, projection, version, createdAt, updatedAt, children };
}

/** Returns a live Dashboard by id or path with its live Widget tree. Fails with `archived` when it or an ancestor is Archived. */
export function dashboardWithWidgets(db: Database, ref: string): DashboardWithWidgets {
  const tree = treeOf(db);
  const row = findDashboard(tree, ref);
  assertDashboardLive(tree, row);
  const widgets = liveWidgetsIn(tree, `d:${row.id}`).map((w) => toWidget(tree, w));
  return { ...toDashboard(tree, row), widgets };
}

function widgetCount(tree: Tree, key: string): number {
  return liveWidgetsIn(tree, key).reduce((n, w) => n + 1 + widgetCount(tree, `w:${w.id}`), 0);
}

function summaries(tree: Tree, row: DashboardRow): DashboardSummary[] {
  const children = liveChildren(tree, row.id);
  const summary: DashboardSummary = {
    id: row.id,
    parentId: row.parentId,
    path: pathOf(tree, row),
    title: row.title,
    icon: row.icon,
    widgetCount: widgetCount(tree, `d:${row.id}`),
    childCount: children.length,
  };
  return [summary, ...children.flatMap((child) => summaries(tree, child))];
}

/** Every live Dashboard, depth first in sibling order, with Widget and child counts. */
export function treeSummaries(db: Database): DashboardSummary[] {
  const tree = treeOf(db);
  return liveChildren(tree, null).flatMap((area) => summaries(tree, area));
}

interface Container {
  key: string;
  dashboardId: string | null;
  parentId: string | null;
}

function resolveContainer(tree: Tree, parent: WidgetParent): Container {
  if ("dashboard" in parent) {
    const dashboard = findDashboard(tree, parent.dashboard);
    assertDashboardLive(tree, dashboard);
    return { key: `d:${dashboard.id}`, dashboardId: dashboard.id, parentId: null };
  }
  const widget = findWidget(tree, parent.widget);
  assertNotArchived(archivedAbove(tree, widget));
  return { key: `w:${widget.id}`, dashboardId: null, parentId: widget.id };
}

function insertWidget(
  db: Database,
  input: WidgetInput,
  container: Container,
  ord: number,
  now: string,
): string {
  const id = createId("w");
  db.run(
    `INSERT INTO widgets (id, dashboardId, parentId, ord, type, title, config, projection, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    container.dashboardId,
    container.parentId,
    ord,
    input.type,
    input.title ?? null,
    JSON.stringify(input.config),
    input.projection === undefined ? null : JSON.stringify(input.projection),
    now,
    now,
  );
  const inner = { key: `w:${id}`, dashboardId: null, parentId: id };
  for (const [index, child] of (input.children ?? []).entries()) {
    insertWidget(db, child, inner, index, now);
  }
  return id;
}

export interface AddWidgetInput {
  parent: WidgetParent;
  widget: WidgetInput;
  position?: Position | undefined;
}

/** Adds a Widget with its whole subtree. The parent's version does not change. */
export function addWidget(db: Database, input: AddWidgetInput, now: string): Widget {
  const tree = treeOf(db);
  const container = resolveContainer(tree, input.parent);
  const id = insertWidget(db, input.widget, container, 0, now);
  const siblings = liveWidgetsIn(tree, container.key).map((w) => w.id);
  writeOrder(db, "widgets", placement(siblings, id, input.position ?? "last"));
  return widgetById(db, id);
}

function widgetById(db: Database, id: string): Widget {
  const tree = treeOf(db);
  return toWidget(tree, findWidget(tree, id));
}

export interface UpdateWidgetInput {
  id: string;
  expectedVersion: number;
  title?: string | undefined;
  config: unknown;
  projection?: unknown;
}

/** Replaces a Widget's own title, config and Projection. Its children stay as they are. */
export function updateWidget(db: Database, input: UpdateWidgetInput, now: string): Widget {
  const tree = treeOf(db);
  const row = findWidget(tree, input.id);
  assertVersion(row, input.expectedVersion, () => toWidget(tree, row));
  assertNotArchived(archivedAbove(tree, row));
  db.run(
    `UPDATE widgets SET title = ?, config = ?, projection = ?, version = version + 1, updatedAt = ?
     WHERE id = ?`,
    input.title ?? null,
    JSON.stringify(input.config),
    input.projection === undefined ? null : JSON.stringify(input.projection),
    now,
    row.id,
  );
  return widgetById(db, row.id);
}

function isDashboardWithin(tree: Tree, row: DashboardRow | undefined, ancestorId: string): boolean {
  if (!row) return false;
  if (row.id === ancestorId) return true;
  return isDashboardWithin(
    tree,
    row.parentId === null ? undefined : tree.dashboards.get(row.parentId),
    ancestorId,
  );
}

export interface MoveInput {
  id: string;
  expectedVersion: number;
  position?: Position | undefined;
}

export interface MoveDashboardInput extends MoveInput {
  /** The new parent by id or path, or `null` to make the Dashboard an Area. */
  parent: string | null;
}

export interface MoveWidgetInput extends MoveInput {
  parent: WidgetParent;
}

/** Moves a Dashboard under another (by id or path), or to the top level as an Area when `parent` is `null`. */
export function moveDashboard(db: Database, input: MoveDashboardInput, now: string): Dashboard {
  const tree = treeOf(db);
  const row = findDashboard(tree, input.id);
  assertVersion(row, input.expectedVersion, () => toDashboard(tree, row));
  assertDashboardLive(tree, row);
  const parent = input.parent === null ? undefined : findDashboard(tree, input.parent);
  if (parent && isDashboardWithin(tree, parent, row.id)) {
    throw new StorageError("invalid", "A Dashboard cannot move under itself or its own children");
  }
  assertDashboardLive(tree, parent);
  const parentId = parent?.id ?? null;
  assertSlugFree(tree, row.slug, parentId, row.id);
  const siblings = liveChildren(tree, parentId).map((d) => d.id);
  const order = placement(siblings, row.id, input.position ?? "last");
  db.run(
    "UPDATE dashboards SET parentId = ?, version = version + 1, updatedAt = ? WHERE id = ?",
    parentId,
    now,
    row.id,
  );
  writeOrder(db, "dashboards", order);
  return dashboardById(db, row.id);
}

function isWidgetWithin(tree: Tree, row: WidgetRow | undefined, ancestorId: string): boolean {
  if (!row) return false;
  if (row.id === ancestorId) return true;
  return isWidgetWithin(
    tree,
    row.parentId === null ? undefined : tree.widgets.get(row.parentId),
    ancestorId,
  );
}

/** Moves a Widget with its subtree onto a Dashboard or into a layout Widget, possibly on another Dashboard. */
export function moveWidget(db: Database, input: MoveWidgetInput, now: string): Widget {
  const tree = treeOf(db);
  const row = findWidget(tree, input.id);
  assertVersion(row, input.expectedVersion, () => toWidget(tree, row));
  assertNotArchived(archivedAbove(tree, row));
  if (
    "widget" in input.parent &&
    isWidgetWithin(tree, tree.widgets.get(input.parent.widget), row.id)
  ) {
    throw new StorageError("invalid", "A Widget cannot move into itself or its own children");
  }
  const container = resolveContainer(tree, input.parent);
  const siblings = liveWidgetsIn(tree, container.key).map((w) => w.id);
  const order = placement(siblings, row.id, input.position ?? "last");
  db.run(
    "UPDATE widgets SET dashboardId = ?, parentId = ?, version = version + 1, updatedAt = ? WHERE id = ?",
    container.dashboardId,
    container.parentId,
    now,
    row.id,
  );
  writeOrder(db, "widgets", order);
  return widgetById(db, row.id);
}

export interface VersionedRef {
  id: string;
  expectedVersion: number;
}

function setArchivedAt(
  db: Database,
  table: "dashboards" | "widgets",
  id: string,
  archivedAt: string | null,
  now: string,
): void {
  db.run(
    `UPDATE ${table} SET archivedAt = ?, version = version + 1, updatedAt = ? WHERE id = ?`,
    archivedAt,
    now,
    id,
  );
}

/** Archives a Dashboard and so everything under it. Archiving it again changes nothing. */
export function archiveDashboard(db: Database, input: VersionedRef, now: string): Dashboard {
  const tree = treeOf(db);
  const row = findDashboard(tree, input.id);
  assertVersion(row, input.expectedVersion, () => toDashboard(tree, row));
  if (row.archivedAt !== null) return toDashboard(tree, row);
  assertDashboardLive(tree, row);
  setArchivedAt(db, "dashboards", row.id, now, now);
  return dashboardById(db, row.id);
}

/**
 * Restores an Archived Dashboard with the subtree it Archived, as the last of its siblings. Fails with `conflict` when a live
 * sibling took its slug, and with `archived` while an ancestor is still Archived.
 */
export function restoreDashboard(db: Database, input: VersionedRef, now: string): Dashboard {
  const tree = treeOf(db);
  const row = findDashboard(tree, input.id);
  assertVersion(row, input.expectedVersion, () => toDashboard(tree, row));
  if (row.archivedAt === null) return toDashboard(tree, row);
  assertDashboardLive(tree, row.parentId === null ? undefined : tree.dashboards.get(row.parentId));
  assertSlugFree(tree, row.slug, row.parentId, row.id);
  setArchivedAt(db, "dashboards", row.id, null, now);
  const siblings = liveChildren(tree, row.parentId).map((d) => d.id);
  writeOrder(db, "dashboards", placement(siblings, row.id, "last"));
  return dashboardById(db, row.id);
}

/** Archives a Widget and its subtree. Archiving it again changes nothing. */
export function archiveWidget(db: Database, input: VersionedRef, now: string): Widget {
  const tree = treeOf(db);
  const row = findWidget(tree, input.id);
  assertVersion(row, input.expectedVersion, () => toWidget(tree, row));
  if (row.archivedAt !== null) return toWidget(tree, row);
  assertNotArchived(archivedAbove(tree, row));
  setArchivedAt(db, "widgets", row.id, now, now);
  return widgetById(db, row.id);
}

/** Restores an Archived Widget with its subtree, as the last of its siblings. Fails with `archived` while an ancestor is still Archived. */
export function restoreWidget(db: Database, input: VersionedRef, now: string): Widget {
  const tree = treeOf(db);
  const row = findWidget(tree, input.id);
  assertVersion(row, input.expectedVersion, () => toWidget(tree, row));
  if (row.archivedAt === null) return toWidget(tree, row);
  assertNotArchived(archivedAbove(tree, { ...row, archivedAt: null }));
  setArchivedAt(db, "widgets", row.id, null, now);
  const siblings = liveWidgetsIn(tree, containerKey(row)).map((w) => w.id);
  writeOrder(db, "widgets", placement(siblings, row.id, "last"));
  return widgetById(db, row.id);
}

export interface ArchivedItem {
  id: string;
  title: string | null;
  archivedAt: string;
  version: number;
}

/** Dashboards and Widgets Archived directly, not those hidden only because an ancestor is. */
export function archivedTreeItems(db: Database): {
  dashboards: ArchivedItem[];
  widgets: ArchivedItem[];
} {
  const tree = treeOf(db);
  const pick = (r: DashboardRow | WidgetRow) =>
    r.archivedAt === null
      ? []
      : [{ id: r.id, title: r.title, archivedAt: r.archivedAt, version: r.version }];
  return {
    dashboards: [...tree.dashboards.values()].flatMap(pick),
    widgets: [...tree.widgets.values()].flatMap(pick),
  };
}
