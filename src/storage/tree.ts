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

/** Describes a Dashboard. A Dashboard with no parent is an Area. */
export interface Dashboard {
  id: string;
  parentId: string | null;
  /** The slugs from the Area down to this Dashboard, joined by `/`. */
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

interface DashboardSummary extends Pick<Dashboard, "id" | "parentId" | "path" | "title" | "icon"> {
  widgetCount: number;
  childCount: number;
}

/**
 * Describes a Widget as an Agent writes it, with its whole subtree. `config` and `projection` are
 * stored as JSON.
 */
interface WidgetInput {
  type: string;
  title?: string | undefined;
  config: unknown;
  projection?: unknown;
  children?: WidgetInput[] | undefined;
}

/** Describes a live Widget with its live children. */
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

interface DashboardWithWidgets extends Dashboard {
  widgets: Widget[];
}

/** Describes where a Widget is: on a Dashboard, found by id or path, or in a layout Widget. */
type WidgetParent = { dashboard: string } | { widget: string };

/** Holds every Dashboard and Widget. Each call reads the whole tree. */
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

/** Returns the nearest Archived Dashboard at or above `row`, or `undefined` if there is none. */
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

/**
 * Returns the nearest Archived Widget or Dashboard at or above `row`, or `undefined` if there is
 * none.
 */
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
    `${archived.kind} ${archived.row.id}${name} is Archived. Restore it first.`,
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

/** Returns the title as lowercase ASCII words joined by `-`. */
function slugFrom(title: string): string {
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

interface CreateDashboardInput {
  /** The id or path of the parent Dashboard. Without it, the new Dashboard is an Area. */
  parent?: string | undefined;
  title: string;
  slug?: string | undefined;
  icon?: string | undefined;
  description?: string | undefined;
  position?: Position | undefined;
}

/**
 * Creates a Dashboard, or an Area if `parent` is not given. Without a `slug`, the slug comes from
 * the title. Throws `StorageError` `conflict` with the sibling if a live sibling has the slug, and
 * `archived` if the parent is Archived.
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

interface UpdateDashboardInput {
  id: string;
  expectedVersion: number;
  title?: string | undefined;
  slug?: string | undefined;
  icon?: string | null | undefined;
  description?: string | null | undefined;
}

/**
 * Changes the given fields of a Dashboard. A new title keeps the old slug. Throws `StorageError`
 * `conflict` if a sibling has the new slug.
 */
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

/**
 * Returns a live Dashboard by id or path, with its live Widget tree. Throws `StorageError`
 * `archived` if the Dashboard or an ancestor is Archived, and `not_found` if there is no such
 * Dashboard.
 */
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

/**
 * Returns every live Dashboard, depth first in sibling order, with its number of Widgets and
 * children.
 */
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

interface AddWidgetInput {
  parent: WidgetParent;
  widget: WidgetInput;
  position?: Position | undefined;
}

/**
 * Adds a Widget with its whole subtree. The version of the parent does not change. Throws
 * `StorageError` `archived` if the parent is Archived.
 */
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

interface UpdateWidgetInput {
  id: string;
  expectedVersion: number;
  title?: string | undefined;
  config: unknown;
  projection?: unknown;
}

/** Replaces the title, config and Projection of a Widget. Its children do not change. */
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

interface MoveInput {
  id: string;
  expectedVersion: number;
  position?: Position | undefined;
}

interface MoveDashboardInput extends MoveInput {
  /** The id or path of the new parent, or `null` to make the Dashboard an Area. */
  parent: string | null;
}

interface MoveWidgetInput extends MoveInput {
  parent: WidgetParent;
}

/**
 * Moves a Dashboard to a new parent. Throws `StorageError` `invalid` if the parent is the Dashboard
 * or under it, and `conflict` if a sibling there has its slug.
 */
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

/**
 * Moves a Widget with its subtree to a Dashboard or a layout Widget, on any Dashboard. Throws
 * `StorageError` `invalid` if the target is the Widget or under it.
 */
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

/** Describes an entity by its id and the version that the caller last read. */
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

/**
 * Archives a Dashboard, which hides everything under it. If it is already Archived, nothing
 * changes.
 */
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
 * Restores an Archived Dashboard and everything under it, as the last of its siblings. Throws
 * `StorageError` `conflict` if a live sibling has its slug, and `archived` if an ancestor is
 * Archived.
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

/** Archives a Widget, which hides its subtree. If it is already Archived, nothing changes. */
export function archiveWidget(db: Database, input: VersionedRef, now: string): Widget {
  const tree = treeOf(db);
  const row = findWidget(tree, input.id);
  assertVersion(row, input.expectedVersion, () => toWidget(tree, row));
  if (row.archivedAt !== null) return toWidget(tree, row);
  assertNotArchived(archivedAbove(tree, row));
  setArchivedAt(db, "widgets", row.id, now, now);
  return widgetById(db, row.id);
}

/**
 * Restores an Archived Widget and its subtree, as the last of its siblings. Throws `StorageError`
 * `archived` if an ancestor is Archived.
 */
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

interface ArchivedItem {
  id: string;
  title: string | null;
  archivedAt: string;
  version: number;
}

/**
 * Returns the Dashboards and Widgets that are Archived themselves. Items under an Archived ancestor
 * are not listed.
 */
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
