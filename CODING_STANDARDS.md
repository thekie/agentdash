# Coding standards

Only rules Biome and `tsc` cannot enforce. Everything they check is out of scope for review.

- **Domain terms.** Name code after `CONTEXT.md` (Dashboard, Widget, Data Store, Projection, Archive). Never use the terms it lists under _Avoid_.
- **Test through the interface.** MCP behaviour is tested with the SDK client against the real handler; UI behaviour with Playwright against the running app. No assertions on SQLite rows or private functions from tests.
- **SQL lives in the storage module.** No SQL strings elsewhere.
- **MCP wiring stays in one place** (`src/app.ts` and the tool modules it registers), because SDK v2 is young and its API may move.
- **Agents never delete.** Removal is Archive.
- **No new runtime dependency** without a ticket that justifies it. Runtime deps are `hono`, `@hono/node-server`, `@modelcontextprotocol/server`, `zod`.
