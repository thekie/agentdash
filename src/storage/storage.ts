import { type Database, openDatabase } from "./database.ts";
import { appendRows, archivedRows, archiveRow, liveRows, restoreRow, updateRows } from "./rows.ts";
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
  restoreDashboard,
  restoreWidget,
  treeSummaries,
  updateDashboard,
  updateWidget,
} from "./tree.ts";

export interface StorageOptions {
  /** The current time as an ISO string. Defaults to the system clock. */
  now?: () => string;
}

/**
 * Opens agentdash's SQLite database at `path` (`:memory:` for tests) and returns every read and
 * write on Dashboards, Widgets, Data Stores and rows. Each write is atomic. Failures an Agent can
 * act on throw `StorageError`.
 */
export function createStorage(path: string, options: StorageOptions = {}) {
  const db = openDatabase(path);
  const now = options.now ?? (() => new Date().toISOString());
  const write =
    <I, O>(change: (db: Database, input: I, now: string) => O) =>
    (input: I): O =>
      db.transaction(() => change(db, input, now()));
  return {
    tree: () => treeSummaries(db),
    dashboard: (ref: string) => dashboardWithWidgets(db, ref),
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

    stores: () => liveStores(db),
    store: (ref: string) => dataStore(db, ref),
    createStore: write(createStore),
    alterStore: write(alterStore),
    archiveStore: write(archiveStore),
    restoreStore: write(restoreStore),

    rows: (store: string) => liveRows(db, store),
    archivedRows: (store: string) => archivedRows(db, store),
    appendRows: write(appendRows),
    updateRows: write(updateRows),
    archiveRow: write(archiveRow),
    restoreRow: write(restoreRow),

    /** Everything Archived directly, so an Agent can find it and restore it. */
    archived: () => ({ ...archivedTreeItems(db), stores: archivedStores(db) }),
    close: () => db.close(),
  };
}

export type Storage = ReturnType<typeof createStorage>;
