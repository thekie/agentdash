import { type Database, openDatabase } from "./database.ts";
import { appendRows, archiveRow, listRows, restoreRow, updateRows } from "./rows.ts";
import {
  alterStore,
  archivedStores,
  archiveStore,
  createStore,
  getStore,
  listStores,
  restoreStore,
} from "./stores.ts";
import {
  addWidget,
  archiveDashboard,
  archivedTreeItems,
  archiveWidget,
  createDashboard,
  getDashboard,
  getTree,
  moveDashboard,
  moveWidget,
  restoreDashboard,
  restoreWidget,
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
    getTree: () => getTree(db),
    getDashboard: (ref: string) => getDashboard(db, ref),
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

    listStores: () => listStores(db),
    getStore: (ref: string) => getStore(db, ref),
    createStore: write(createStore),
    alterStore: write(alterStore),
    archiveStore: write(archiveStore),
    restoreStore: write(restoreStore),

    listRows: (store: string, filter?: { archived?: boolean }) => listRows(db, store, filter),
    appendRows: write(appendRows),
    updateRows: write(updateRows),
    archiveRow: write(archiveRow),
    restoreRow: write(restoreRow),

    /** Everything Archived directly, so an Agent can find it and restore it. */
    listArchived: () => ({ ...archivedTreeItems(db), stores: archivedStores(db) }),
    close: () => db.close(),
  };
}

export type Storage = ReturnType<typeof createStorage>;
