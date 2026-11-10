import { type Database, openDatabase } from "./database.ts";
import type { Path } from "./errors.ts";
import type { ProjectionInput } from "./projection.ts";
import { projectionColumns, queryProjection } from "./query.ts";
import {
  appendRows,
  archivedRows,
  archiveRow,
  listRows,
  liveRows,
  restoreRow,
  updateRows,
} from "./rows.ts";
import {
  alterStore,
  archivedStores,
  archiveStore,
  createStore,
  dataStore,
  liveStores,
  restoreStore,
} from "./stores.ts";
import {
  addWidget,
  archiveDashboard,
  archivedTreeItems,
  archiveWidget,
  createDashboard,
  dashboardWithWidgets,
  moveDashboard,
  moveWidget,
  parentWidgetOf,
  restoreDashboard,
  restoreWidget,
  storeReaders,
  treeSummaries,
  updateDashboard,
  updateWidget,
  widgetById,
} from "./tree.ts";

interface StorageOptions {
  /** Returns the current time as an ISO string. The default reads the system clock. */
  now?: () => string;
}

/**
 * Opens the SQLite database at `path` and returns the reads and writes on Dashboards, Widgets, Data
 * Stores and rows. Each write is atomic. A write throws `StorageError` for a failure that an Agent
 * can correct.
 */
export function createStorage(path: string, options: StorageOptions = {}) {
  const db = openDatabase(path);
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<() => void>();
  const write =
    <I, O>(change: (db: Database, input: I, now: string) => O) =>
    (input: I): O => {
      const result = db.transaction(() => change(db, input, now()));
      for (const listener of listeners) listener();
      return result;
    };
  return {
    tree: () => treeSummaries(db),
    dashboard: (ref: string) => dashboardWithWidgets(db, ref),
    widget: (id: string) => widgetById(db, id),
    parentWidget: (id: string) => parentWidgetOf(db, id),
    createDashboard: write(createDashboard),
    updateDashboard: write(updateDashboard),
    moveDashboard: write(moveDashboard),
    archiveDashboard: write(archiveDashboard),
    restoreDashboard: write(restoreDashboard),

    addWidget: write(addWidget),
    updateWidget: write(updateWidget),
    moveWidget: write(moveWidget),
    archiveWidget: write(archiveWidget),
    restoreWidget: write(restoreWidget),

    stores: () => {
      const readers = storeReaders(db);
      return liveStores(db).map((store) => ({ ...store, readers: readers.get(store.id) ?? [] }));
    },
    store: (ref: string) => {
      const store = dataStore(db, ref);
      return { ...store, readers: storeReaders(db).get(store.id) ?? [] };
    },
    createStore: write(createStore),
    alterStore: write(alterStore),
    archiveStore: write(archiveStore),
    restoreStore: write(restoreStore),

    rows: (store: string) => liveRows(db, store),
    listRows: (input: Parameters<typeof listRows>[1]) => listRows(db, input, now()),
    archivedRows: (store: string) => archivedRows(db, store),
    appendRows: write(appendRows),
    updateRows: write(updateRows),
    archiveRow: write(archiveRow),
    restoreRow: write(restoreRow),

    query: (projection: ProjectionInput) => queryProjection(db, projection, now()),
    projectionColumns: (projection: unknown, path: Path) => projectionColumns(db, projection, path),

    /**
     * Returns the Dashboards, Widgets and Data Stores that are Archived themselves, without the
     * items under them.
     */
    archived: () => ({ ...archivedTreeItems(db), stores: archivedStores(db) }),
    /** Adds a listener that runs after each write that succeeds. Returns its removal. */
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: () => db.close(),
  };
}

export { ColumnKey, ColumnSpec, type ColumnType } from "./columns.ts";
export { type Issue, type Path, StorageError } from "./errors.ts";
export { Projection } from "./projection.ts";
export { AlterOp } from "./stores.ts";

/** Describes the object that `createStorage` returns. */
export type Storage = ReturnType<typeof createStorage>;
