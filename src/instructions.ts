/** The primer that the MCP server sends to every Agent when it connects. */
export const instructions = `Use this server when the Owner wants to track, chart or show something: spending, weight, workouts, a goal, a checklist, tips. You build it as Dashboards of Widgets over Data Stores.

This server holds the Owner's Dashboards. Agents write everything, and the Owner reads it in the browser, live. Several Agents can work at the same time.

Terms:
- A Dashboard is a page of Widgets. Dashboards nest to any depth. An Area is a Dashboard with no parent, such as Finance or Health.
- A Widget is one block of a type from the fixed Widget Catalog. columns and section Widgets hold other Widgets.
- A Data Store is a table whose columns you define and whose rows you append. A Key is the set of columns that identify a row, such as the date in a weight log.
- A Projection says which Data Stores a data Widget reads and how it filters, joins, groups and aggregates them. Its slots name the columns that the Widget draws.

How to work:
- Call dashboard_tree before you create anything, and reuse what exists. A taken slug or Data Store name fails with conflict and returns the existing one.
- Put numbers in a Data Store and bind a Widget to it. A note does not update, so keep numbers out of notes.
- Give a Data Store a Key when its rows have a natural identity. A retried append then cannot add a row twice, and onConflict "update" re-syncs rows.
- A retried widget_add adds a second Widget. If a call got no reply, call dashboard_get before you add the Widget again.
- Try a Projection with projection_query before you bind a Widget to it.
- Nothing is deleted. item_archive hides a Dashboard, Widget, Data Store or row, item_restore brings it back, and archive_list shows what is Archived.
- Every change to an existing item needs expectedVersion, the version you last read. A conflict returns the current state: merge your change into it and retry with its version.
- Errors carry a code (not_found, invalid, conflict, archived) and the problems with their paths and valid values.
- Money is a decimal in major units, dates are ISO strings, and enum values are labels.`;
