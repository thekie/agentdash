# Data model: typed Data Stores, schema evolution and Widget binding

Question: which column types should Agent-defined Data Stores support, how should their schema change once they hold rows, how should Widgets get data shaped for their slots (including from several Data Stores), and can agent-written SQL be confined safely in `node:sqlite`?

Sources were read on 2026-11-01. Every claim links to the page that owns it. Claims marked **[inference]** or **[unverified]** are the author's reading and are not stated by the source. The `node:sqlite` behaviour under "Measured" was run on Node 26.4.0 with SQLite 3.53.2 (scripts in the appendix).

## Recommendation for v1

1. **Column types:** `text`, `number` (with `format: plain | percent`), `money` (one ISO 4217 currency per column), `date`, `datetime`, `boolean`, `enum` (single choice, options with stable ids). Store them in `STRICT` SQLite tables: `money` as INTEGER minor units, `date` as `YYYY-MM-DD` TEXT, `datetime` as ISO 8601 UTC TEXT with `Z`, `boolean` as INTEGER 0/1, `enum` as the option id. Defer links, formulas, multi-select and attachments.
2. **Schema evolution:** the physical column name is a stable id (`c_<n>`), and the Agent-facing key and label live in metadata. Rename changes metadata only. Add is nullable with no backfill. Retype is a dry run first, then a copy into a new physical column, where unconvertible values become NULL and the old column is kept and archived. Remove is archive (hidden, restorable), never `DROP COLUMN`.
3. **Binding:** each Widget carries a declarative **projection** in JSON (`from`, optional equi-`join`s to other Data Stores, `filter`, `groupBy` with time buckets, `aggregate`, `sort`, `limit`) plus a **slot map** (`x`, `y`, `series`, `value`, ...). agentdash validates the projection against the Data Store schemas, returns errors that name the valid columns, and compiles it to parameterised SQL itself. No agent-written SQL in v1.
4. **Defense in depth:** compiled projections run on a separate `readOnly` connection with an authorizer that allows only `SELECT`, reads of Data Store tables, and an allowlist of functions, with low `limits` and a hard row cap.

## 1. Column types in comparable tools

| Tool | Numbers | Money / percent | Dates | Enums | Storage notes |
| - | - | - | - | - | - |
| Airtable | Number, precision 0-8 [1] | Currency: precision 0-7 and a display `symbol`, no ISO code. Percent 12.3% is stored as 0.123 [1] | Separate Date (ISO date, no timezone) and Date and time (with `timeZone` display option) [1] | Single/multiple select; choices have `{id, name, color}`, but cells are read and written by name [1] | 33 field types including link, formula, rollup, lookup [1] |
| Notion | One `number` type [2] | `number.format` (percent, dollar, euro, ...) is display only; 0.25 shows as 25% [2][3] | `date` value is `{start, end?, time_zone?}` [3] | `select`, `multi_select`, `status`; option ids survive renames, values written by id or name [2][3] | 24 property types [2] |
| Baserow | Number, 0-10 decimal places [4] | Currency and percent are prefix/suffix on Number [4] | Date or Date and time, timezone per field, UTC by default [5] | Single select stored as a foreign key to the option id [6] | Each table is a real Postgres table with columns `field_{id}` [7] |
| NocoDB | Number (`bigint`), Decimal [8][9] | Currency (`decimal` on Postgres, `double precision` on SQLite), Percent (`double`) [8][9] | Date, Time, Date and time, Duration [10] | Single/Multi select stored as `text`, so by label [8][9] **[inference]** | Full list in `UITypes` [11] |
| Directus | Integer, Big Integer, Float, Decimal (default precision 10, scale 5) [12][13] | None [12] | Timestamp (normalised to UTC), DateTime (no timezone), Date, Time [14] | Dropdown interface stores the choice `value` [14] | Types are database column types [12] |
| Grist | Numeric, Integer [15] | Currency and percent are Numeric formats [15] | Date is epoch seconds at midnight UTC; DateTime is epoch seconds UTC with `DateTime:<tz>` for display [16] | Choice stored as the label string [16] | Any value fits any column; mismatches are kept and flagged [15][16] |
| Datasette | Write API column types are `text`, `integer`, `float`, `blob` [17] | None | sqlite-utils stores date/datetime as TEXT [18] | None | Plain SQLite affinities [17][18] |

What they share:

- Money is a number plus display metadata in Airtable, Notion, Baserow and Grist. None of them stores a currency code per value [1][2][4][15].
- Percent is a display format over a fraction [1][3].
- All of them keep date and datetime as separate types, and datetimes are UTC with a display timezone (Airtable, Baserow, Grist, Directus Timestamp) [1][5][14][16].
- Enum options get stable ids in Airtable, Notion and Baserow, and labels are what the API speaks [1][3][6].
- SQLite itself has no DATE or BOOLEAN storage class. Dates go in TEXT, REAL or INTEGER, booleans are 0/1, and `DECIMAL(p,s)` gets NUMERIC affinity, so values are stored as REAL or INTEGER with no fixed scale [19]. `STRICT` tables (SQLite 3.37.0+) restrict column types to INT, INTEGER, REAL, TEXT, BLOB or ANY and raise `SQLITE_CONSTRAINT_DATATYPE` on a mismatch [20].

**Minimal set for dashboards.** Seven types cover numbers, money, dates and enums:

| Type | Options | SQLite storage (STRICT) |
| - | - | - |
| `text` | | TEXT |
| `number` | `decimals?` (display), `format: plain \| percent` | REAL. Percent is a fraction |
| `money` | `currency` (ISO 4217, per column), `decimals` (default 2) | INTEGER minor units. Avoids float rounding, since SQLite has no fixed-scale decimal [19] |
| `date` | | TEXT `YYYY-MM-DD` |
| `datetime` | `displayTz?` (IANA) | TEXT ISO 8601 UTC ending in `Z` |
| `boolean` | | INTEGER 0/1 |
| `enum` | `options: [{id, label, color?}]` | TEXT option id. The MCP API accepts and returns labels and maps them to ids |

A "time series" is a Data Store with a `date` or `datetime` column, as CONTEXT.md already says. The MCP tool should take money as a decimal number and convert it to minor units itself, so Agents never do the arithmetic.

## 2. Schema evolution in comparable tools

| Operation | What the tools do |
| - | - |
| Add | NocoDB applies a default only to new records, and existing rows are not backfilled [10]. sqlite-utils `add_column` defaults to TEXT [18]. SQLite `ADD COLUMN` rejects PRIMARY KEY, UNIQUE, NOT NULL with a NULL default, non-constant defaults and STORED generated columns. Since 3.37 an added CHECK is tested against existing rows [21] |
| Rename | Notion property ids stay the same across renames and formulas store the id [2]. Grist formulas use the column id, which is separate from the label, and update automatically [22]. Baserow rewrites `field('name')` references in formulas [23]. Airtable updates formula references [24]. Directus forbids changing a field key after creation [12]. SQLite `RENAME COLUMN` updates indexes, triggers and views [21] |
| Retype | Baserow runs `ALTER COLUMN ... TYPE ... USING try_cast(...)`, and a failed cast sets the value to NULL [25]. Airtable "tries to convert", and some conversions clear values [26]. Grist keeps a value that doesn't fit and flags it, and shows a preview before converting [15][27]. Notion warns a type change "can make existing values unreadable" [28]. Directus forbids type changes [12]. The Airtable API cannot change a field's type at all [29]. sqlite-utils `transform()` turns exact empty strings into NULL when going to INTEGER or FLOAT and copies everything else as-is [18] |
| Remove | Soft in Airtable (base trash, 7 days, restorable with links) [30], Baserow (trash, 3 days, configurable when self-hosted) [31] and Notion ("Deleted properties", restorable) [28][32]. Hard in NocoDB ("cannot be undone") [33], Directus (`dropColumn`) [34] and Datasette [17]. SQLite `DROP COLUMN` fails for PK, UNIQUE, indexed, foreign-key, generated, trigger- and view-referenced columns [21] |

SQLite changes it cannot do in place need the 12-step rebuild: foreign keys off, begin, create `new_X`, `INSERT ... SELECT`, drop `X`, rename `new_X` to `X`, recreate indexes, triggers and views, `foreign_key_check`, commit [21]. sqlite-utils `transform()` implements this in one transaction but does not rewrite views or triggers [18].

**Rules for agentdash v1:**

- **Stable physical names.** Each Data Store is a table `ds_<id>` and each column is `c_<n>`. The Agent-facing `key` and `label` live in a metadata table. Projections are stored with column ids and shown to Agents with current keys. Rename is then a metadata update and never breaks a Widget, the pattern of Notion, Grist and Baserow [2][7][22].
- **Add:** always nullable, no backfill. An optional default applies to new rows only. Plain `ALTER TABLE ADD COLUMN` without constraints, which SQLite allows [21].
- **Retype:** an explicit `dryRun` reports how many values would not convert, with samples, as Grist's preview does [27]. Applying it adds a new physical column, copies converted values, and sets unconvertible ones to NULL (Baserow's rule [25]). The old physical column is kept and archived, so nothing is lost. Converting anything to `text` always succeeds.
- **Enum options:** add and relabel freely (ids are stable). Removing an option archives it. Rows keep the id and display the archived label.
- **Remove:** archive the column: hidden from Widgets and MCP reads, restorable, physical data untouched. No `DROP COLUMN`, consistent with "Agents never delete permanently" (CONTEXT.md).
- **Rows:** `archived_at` on each row; projections filter archived rows by default.
- **References:** a projection that points at an archived or missing column fails validation with an explicit error and the Widget shows an error state, which is what `lightdash validate` does for charts with deleted fields [35].

## 3. How dashboard tools shape data for a visual

| Tool | Shaping form | Combining several tables | Mapping to slots |
| - | - | - | - |
| Grafana | Per-panel query, then a chain of declarative transformations [36] | "Join by field" (inner or outer), "Merge series/tables" [36] | No explicit x/y. Roles inferred from field types; overrides match fields by name, regex, query or type [37] |
| Metabase | Query builder or native SQL [38] | Builder joins (left, right, inner, full) within one database, chainable [39]; multi-series cards on a shared dimension [40] | Viz settings `graph.dimensions` (x, breakout) and `graph.metrics` (y) as column names [41] |
| Evidence | SQL in markdown code fences, `{{query}}` substitution [42] | "All joins between sources should be handled in models, not in reports" [43] | Component props `data`, `x`, `y`, `y2`, `series`; `y` may be an aggregate expression [44][45] |
| Observable Framework | Data loaders plus DuckDB SQL; `sql:` front matter registers files as tables [46] | SQL joins in DuckDB **[inference]** | Plot channels take a column name, accessor or array [47] |
| Rill | Semantic layer: a metrics view over one model with dimensions and SQL-aggregate measures [48] | Upstream in SQL models; the metrics view itself has no joins [48] | Canvas components bind one metrics view and map `x`, `y`, `color` to fields; names are case sensitive and must match [49] |
| Lightdash | Semantic layer in dbt YAML (`meta.metrics`) [50] | Explore `joins` with `sql_on`, `type`, `relationship` [51] | `metricQuery` plus `xField` / `yField` as field ids [52] |
| Perses | Dashboard-as-code; panel plugin spec plus `queries[]` [53] | `JoinByColumnValue`, `MergeColumns`, `MergeSeries` transforms [54] | Plugin-specific, CUE-validated [53][55] |
| Vega-Lite | Declarative `transform` array (filter, aggregate, calculate, fold, pivot, window, ...) run in order [56] | `lookup`, "similar to a one sided join", with a `default` for misses [57] | `encoding.<channel>: {field, type, aggregate, timeUnit}` [58] |

Three patterns recur: SQL per visual (Evidence, Observable, Metabase native), declarative transforms after a query (Grafana, Perses, Vega-Lite), and a semantic layer with field-name binding (Rill, Lightdash). Only Metabase's builder, Lightdash explores, Grafana and Perses transforms, and Vega-Lite `lookup` combine tables without hand-written SQL [36][39][51][54][57]. Every tool maps result columns to slots by name.

Name validation varies. Lightdash fails compilation on a metric reference that "matches no metric" and has a `validate` command for charts whose fields no longer exist [50][35]. Perses strict lint "rejects the unknown or misspelled fields ... which are otherwise silently ignored" [55]. Evidence underlines invalid component attributes [59]. Vega-Lite's warning messages cover structural problems but none checks whether a field exists in the data, so a misspelled field yields empty marks [60] **[inference from the source]**.

**For agentdash:** a projection in Vega-Lite/Grafana style, scoped to Data Stores and compiled to SQL by agentdash:

```json
{
  "from": "weight_log",
  "join": [{ "store": "budget", "type": "left", "on": { "left": "month", "right": "month" } }],
  "filter": [{ "column": "day", "op": ">=", "value": "2026-01-01" }],
  "groupBy": [{ "column": "day", "bucket": "week", "as": "week" }],
  "aggregate": [{ "op": "avg", "column": "kg", "as": "avg_kg" }],
  "sort": [{ "column": "week" }],
  "limit": 500,
  "slots": { "x": "week", "y": ["avg_kg"] }
}
```

Each Widget type in the catalog declares its slots and the column types each slot accepts (`x` takes `date | datetime | enum | text`, `y` takes `number | money`). Validation checks every reference against the schemas and slot types before saving and returns errors that list the valid columns.

## 4. Confining agent-written SQL in `node:sqlite`

### What `node:sqlite` offers

`node:sqlite` is stability 1.2, release candidate [61]. All APIs are synchronous [61].

- **Read-only connection:** `readOnly: true` opens the file read-only [61].
- **Defensive flag:** on by default since v25.5.0 / v24.14.0. It disables "language features that allow ordinary SQL to deliberately corrupt the database file" [61].
- **Extensions:** `allowExtension` defaults to `false`, which disables `load_extension` [61].
- **Authorizer:** `database.setAuthorizer(callback)` (v24.10.0+) wraps `sqlite3_set_authorizer()`. The callback gets the action code, table, column, database and trigger/view name and returns `SQLITE_OK`, `SQLITE_DENY` or `SQLITE_IGNORE` [61]. SQLite invokes it while the statement is compiled [62]. `SELECT count(*) FROM tab` still produces one `SQLITE_READ` for the table with an empty column name, so table-level checks see it [62].
- **Limits:** a `limits` constructor option and a runtime `database.limits` object (the accessor is documented as v25.8.0+) cover `length`, `sqlLength`, `column`, `exprDepth`, `compoundSelect`, `vdbeOp`, `functionArg`, `attach`, `likePatternLength`, `variableNumber` and `triggerDepth` [61]. SQLite suggests high-security values such as `LIMIT_SQL_LENGTH` 100,000, `LIMIT_EXPR_DEPTH` 10, `LIMIT_COMPOUND_SELECT` 3 [63]. `vdbeOp` limits the size of the compiled program, not the number of steps executed [64].
- **Statement counters:** `statement.stat('vmStep' | 'fullscanStep' | ...)` (v26.8.0+) reads `sqlite3_stmt_status()` after or between steps [61].
- **No interrupt, no progress handler, no heap limit.** The `timeout` option is the busy timeout for locks, not a query timeout [61]. The docs expose neither `sqlite3_interrupt()` nor `sqlite3_progress_handler()` [61]. A feature request for `interrupt()` was closed as stale; a maintainer noted operations are "blocking and single-threaded" [65]. SQLite's own advice for untrusted SQL is a progress handler or a timer that calls `sqlite3_interrupt()`, plus `sqlite3_hard_heap_limit64()` [63].

### Measured (Node 26.4.0, SQLite 3.53.2)

With a `readOnly` connection and an authorizer that allows `SQLITE_SELECT`, `SQLITE_READ` only on tables named `ds_*`, and `SQLITE_FUNCTION` only from an allowlist:

| SQL | Result |
| - | - |
| `INSERT INTO ds_weight ...` | `attempt to write a readonly database` |
| `SELECT ... FROM ds_weight w LEFT JOIN ds_budget b ON ...` | Allowed |
| `SELECT token_hash FROM agents` | `access to agents.token_hash is prohibited` |
| `SELECT name FROM sqlite_schema` | `access to sqlite_master.name is prohibited` |
| `SELECT load_extension('x')`, `SELECT randomblob(10)` | `not authorized to use function` |
| `PRAGMA table_info(agents)`, `ATTACH 't.db' AS x` | `not authorized` |
| `WITH RECURSIVE ...` | `not authorized` (`SQLITE_RECURSIVE` is denied) |
| `SELECT count(*) FROM ds_weight a, ds_weight b, ds_weight c` | Allowed. A cross join is finite but can still be very large |
| `r.limits.sqlLength = 2000`, then a longer statement | `string or blob too big` |

An unbounded `WITH RECURSIVE` query in a `worker_threads` Worker kept running, and `worker.terminate()` had not resolved 5.5 seconds later. The main event loop stayed responsive, but the only way to stop the query was to kill the process. So a hard time limit for arbitrary SQL in `node:sqlite` needs a child process that can be killed, not a Worker or a timer.

### Confining SQL compared with a declarative projection

The authorizer and a read-only connection confine *what* SQL can touch well: writes, schema, PRAGMA, ATTACH, non-Data Store tables and unlisted functions all fail at prepare time, as measured above. They cannot confine *how long* a query runs. Denying `SQLITE_RECURSIVE` removes unbounded loops, but cross joins and large sorts remain. Without interrupt or a progress handler, the remaining options are a killable child process per query (process start-up per Widget render) or a pool of them.

A compiled projection removes these problems by construction. agentdash writes the SQL, so joins are equi-joins on declared columns, there is always a `LIMIT`, recursion and arbitrary functions never appear, and values are bound parameters. The authorizer stays in place as a second line of defense against compiler bugs.

On LLM error rates, no published study compares SQL against a declarative spec on the same tasks; the benchmarks below use different tasks and metrics:

- Text-to-SQL on realistic schemas is still hard. On Spider 2.0, o1-preview with an agent framework solved 21.3% of tasks, against 91.2% on Spider 1.0 and 73.0% on BIRD [66]. The BIRD leaderboard shows human performance at 92.96% execution accuracy [67].
- Declarative chart specs fail too. Generating Vega-Lite on nvBench, the best prompting strategy reached 65.75% valid and 37.06% legal output, and zero-shot 12.86% valid [68]. VisEval found GPT-4 passing 75.27% of 2,524 queries, and lists "references to non-existent data columns" among the error classes [69].

So a declarative form does not make LLM authors accurate by itself. What it adds is that every wrong reference can be caught before saving with a precise message the Agent can fix in one round, and the error surface is the small set of fields agentdash defines. For SQL, the comparable check is "does it prepare", which catches unknown columns but not wrong joins or wrong aggregation **[inference]**.

## Trade-offs and risks

- **Expressiveness.** A projection cannot express window functions, ratios between aggregates, or arbitrary CASE logic. The likely first additions are a small `calculate` expression set (arithmetic on aggregates) and running totals. Raw SQL can be added later behind a killable child process if real Widgets need it.
- **We own a compiler.** Projection-to-SQL compilation, validation and error messages are agentdash code to test. SQL injection is avoided only if every identifier comes from metadata and every value is bound.
- **Money as minor units.** Correct sums, but one currency per column. Mixed-currency stores need a `text` currency column and a `number` amount instead. Currencies with 0 or 3 minor digits need `decimals` from ISO 4217.
- **Datetime as TEXT.** ISO UTC strings sort correctly and work with SQLite date functions, but time buckets in the Owner's timezone need offset handling in the compiler.
- **Join cost.** Equi-joins on unindexed columns scan both tables. Cap joins (for example at three Data Stores), create an index when a column is used as a join key, and keep a row cap on every result.
- **`node:sqlite` is a release candidate**, and `limits` (v25.8.0) and `stat()` (v26.8.0) are recent [61]. The stack research pins `>=24.15`, which has `readOnly` and `setAuthorizer` but not `limits`, so the floor would rise to 25.8 if limits are wanted [61].
- **Archive keeps everything.** Archived columns and retype copies stay in the table, and SQLite's default limit is 2,000 columns per table [63]. A Data Store with many retypes may eventually need the 12-step rebuild to compact it.

## References

1. Airtable, Field model: https://airtable.com/developers/web/api/field-model
2. Notion API, Property object: https://developers.notion.com/reference/property-object
3. Notion API, Page property values: https://developers.notion.com/reference/page-property-values
4. Baserow, Number field: https://baserow.io/user-docs/number-field
5. Baserow, Working with timezones: https://baserow.io/user-docs/working-with-timezones
6. Baserow source, `field_types.py`: https://github.com/baserow/baserow/blob/master/backend/src/baserow/contrib/database/fields/field_types.py
7. Baserow, Database plugin (technical): https://github.com/baserow/baserow/blob/master/docs/technical/database-plugin.md
8. NocoDB source, `PgUi.ts`: https://github.com/nocodb/nocodb/blob/develop/packages/nocodb-sdk/src/lib/sqlUi/PgUi.ts
9. NocoDB source, `SqliteUi.ts`: https://github.com/nocodb/nocodb/blob/develop/packages/nocodb-sdk/src/lib/sqlUi/SqliteUi.ts
10. NocoDB, Fields: https://nocodb.com/docs/product/tables/fields
11. NocoDB source, `UITypes.ts`: https://github.com/nocodb/nocodb/blob/develop/packages/nocodb-sdk/src/lib/UITypes.ts
12. Directus, Fields: https://directus.com/docs/guides/data-model/fields
13. Directus source, `number.ts`: https://github.com/directus/directus/blob/main/packages/constants/src/number.ts
14. Directus, Interfaces: https://directus.com/docs/guides/data-model/interfaces
15. Grist, Column types: https://support.getgrist.com/col-types/
16. Grist, Data format: https://github.com/gristlabs/grist-core/blob/main/documentation/grist-data-format.md
17. Datasette, JSON API (write API): https://docs.datasette.io/en/latest/json_api.html
18. sqlite-utils, Python API: https://sqlite-utils.datasette.io/en/stable/python-api.html
19. SQLite, Datatypes: https://www.sqlite.org/datatype3.html
20. SQLite, STRICT tables: https://www.sqlite.org/stricttables.html
21. SQLite, ALTER TABLE: https://www.sqlite.org/lang_altertable.html
22. Grist, Formulas: https://support.getgrist.com/formulas/ and newsletter 2020-08: https://support.getgrist.com/newsletters/2020-08/
23. Baserow, Formula technical guide: https://baserow.io/docs/technical/formula-technical-guide
24. Airtable, Formula writing tips: https://support.airtable.com/articles/5127213530-formula-writing-tips-for-beginners
25. Baserow source, `schema.py`: https://github.com/baserow/baserow/blob/master/backend/src/baserow/contrib/database/db/schema.py
26. Airtable, Field type overview: https://support.airtable.com/articles/2361876459-field-type-overview
27. Grist, Dates (conversion preview): https://support.getgrist.com/dates/
28. Notion API, Update data source properties: https://developers.notion.com/reference/update-data-source-properties
29. Airtable API, Update field: https://airtable.com/developers/web/api/update-field
30. Airtable, Managing trash: https://support.airtable.com/docs/managing-trash-in-airtable
31. Baserow, Data recovery and deletion: https://baserow.io/user-docs/data-recovery-and-deletion
32. Notion, Duplicate, delete and restore content: https://www.notion.com/help/duplicate-delete-and-restore-content
33. NocoDB, Actions on field: https://nocodb.com/docs/product/tables/fields/actions-on-field
34. Directus source, `fields.ts`: https://github.com/directus/directus/blob/main/api/src/services/fields.ts
35. Lightdash, `lightdash validate`: https://docs.lightdash.com/guides/cli/how-to-use-lightdash-validate
36. Grafana, Transform data: https://grafana.com/docs/grafana/latest/panels-visualizations/query-transform-data/transform-data/
37. Grafana, Configure overrides: https://grafana.com/docs/grafana/latest/panels-visualizations/configure-overrides/
38. Metabase, Writing SQL: https://www.metabase.com/docs/latest/questions/native-editor/writing-sql
39. Metabase, Joins: https://www.metabase.com/docs/latest/questions/query-builder/join
40. Metabase, Multiple series: https://www.metabase.com/docs/latest/dashboards/multiple-series
41. Metabase source, `columns.ts`: https://github.com/metabase/metabase/blob/master/frontend/src/metabase/viz-core/lib/graph/columns.ts
42. Evidence, Markdown: https://github.com/evidence-dev/evidence/blob/main/docs/core-concepts/markdown.mdx
43. Evidence, Models: https://github.com/evidence-dev/evidence/blob/main/docs/core-concepts/models.mdx
44. Evidence, Bar chart: https://github.com/evidence-dev/evidence/blob/main/docs/components/bar_chart.mdx
45. Evidence, Line chart: https://docs.evidence.dev/components/charts/line-chart
46. Observable Framework, SQL: https://github.com/observablehq/framework/blob/main/docs/sql.md
47. Observable Plot, Marks: https://observablehq.com/plot/features/marks
48. Rill, Metrics views: https://docs.rilldata.com/reference/project-files/metrics-views
49. Rill, Canvas dashboards: https://docs.rilldata.com/reference/project-files/canvas-dashboards
50. Lightdash, Metrics: https://docs.lightdash.com/references/metrics
51. Lightdash, Joins: https://docs.lightdash.com/references/joins
52. Lightdash, chart-as-code fixture: https://github.com/lightdash/lightdash/blob/main/packages/api-tests/fixtures/chartAsCode.yml
53. Perses, Dashboard API: https://perses.dev/perses/docs/api/dashboard/
54. Perses, Common plugin schemas: https://github.com/perses/perses/blob/main/docs/plugins/common.md
55. Perses, CLI (`percli lint`): https://github.com/perses/perses/blob/main/docs/cli.md
56. Vega-Lite, Transform: https://vega.github.io/vega-lite/docs/transform.html
57. Vega-Lite, Lookup: https://vega.github.io/vega-lite/docs/lookup.html
58. Vega-Lite, Encoding: https://vega.github.io/vega-lite/docs/encoding.html
59. Evidence, Components: https://github.com/evidence-dev/evidence/blob/main/docs/core-concepts/components.mdx
60. Vega-Lite source, `message.ts`: https://github.com/vega/vega-lite/blob/main/src/log/message.ts
61. Node.js, SQLite (v26.x docs): https://nodejs.org/api/sqlite.html (source: https://github.com/nodejs/node/blob/v26.x/doc/api/sqlite.md)
62. SQLite, `sqlite3_set_authorizer`: https://www.sqlite.org/c3ref/set_authorizer.html
63. SQLite, Defense against the dark arts: https://www.sqlite.org/security.html
64. SQLite, Run-time limit categories: https://www.sqlite.org/c3ref/c_limit_attached.html
65. Node.js issue, "sqlite: interrupt()": https://github.com/nodejs/node/issues/62227
66. Spider 2.0 (ICLR 2025): https://arxiv.org/abs/2411.07763
67. BIRD leaderboard: https://bird-bench.github.io/
68. Automated data visualization from natural language via LLMs (nvBench, Vega-Lite): https://arxiv.org/abs/2401.11255
69. VisEval: https://arxiv.org/abs/2407.00981

## Appendix: measurement scripts

Authorizer and read-only check (Node 26.4 exports the class as `DatabaseSync`; 26.11+ calls it `Database`):

```js
import { DatabaseSync as Database, constants as C } from 'node:sqlite';
const r = new Database('t.db', { readOnly: true });
const fns = new Set(['sum','avg','min','max','count','total','round','date','strftime','coalesce','abs','substr','lower','upper']);
r.setAuthorizer((code, a1, a2) => {
  if (code === C.SQLITE_SELECT) return C.SQLITE_OK;
  if (code === C.SQLITE_READ) return a1?.startsWith('ds_') ? C.SQLITE_OK : C.SQLITE_DENY;
  if (code === C.SQLITE_FUNCTION) return fns.has(String(a2).toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
  return C.SQLITE_DENY;
});
```

Worker termination check:

```js
import { DatabaseSync as Database } from 'node:sqlite';
import { Worker, isMainThread } from 'node:worker_threads';
if (isMainThread) {
  const w = new Worker(new URL(import.meta.url));
  setTimeout(async () => console.log('terminated', await w.terminate()), 500); // never logs
} else {
  new Database(':memory:').prepare(
    'with recursive c(x) as (select 1 union all select x+1 from c) select count(*) from c').get();
}
```
