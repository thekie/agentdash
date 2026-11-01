# Stack for one npx-installable agentdash process

Research for the question: which web framework, MCP SDK setup, and SQLite layer fit one TypeScript process that serves a read-only web UI, an MCP server over Streamable HTTP with per-Agent bearer tokens, and server-sent events, backed by SQLite and installed with `npx agentdash`?

Checked 2026-11-01 against npm, official docs, and published package sources. Versions are the `latest` dist-tag on that date.

## Recommendation

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node.js, `engines: ">=24.15"` | 24 LTS (Krypton), 26 LTS (Lithium) |
| HTTP server | Hono on `@hono/node-server` | hono 4.13.16, @hono/node-server 2.1.5 |
| MCP | `@modelcontextprotocol/server` (SDK v2) via `createMcpHandler`, mounted on a Hono route | 2.4.0 |
| Agent auth | Own Hono middleware: hash the bearer token, look up the Agent, pass `authInfo` to the MCP handler | none |
| Live updates | `streamSSE` from `hono/streaming`, fed by an in-process event emitter after each write | in hono |
| SQLite | `node:sqlite` (built into Node), hand-written SQL behind one storage module, migrations via `PRAGMA user_version` | SQLite 3.53 bundled |
| Frontend | React + Vite, built at publish time to static files served by `@hono/node-server/serve-static` | react 19.3.1, vite 8.3.5 |
| Validation | zod 4 (already required by the MCP SDK for tool schemas) | 4.6.7 |

Runtime dependencies: `hono`, `@hono/node-server`, `@modelcontextprotocol/server` (which pulls `@modelcontextprotocol/core` and `zod`). No native modules, so `npx agentdash` never compiles anything. React and Vite are dev dependencies; only their build output ships.

## Server framework

**Hono** has zero runtime dependencies ([npm](https://www.npmjs.com/package/hono): `dependencies` empty, `engines.node >=16.9.0`), and `@hono/node-server` also has none (`engines.node >=20`). It works on web-standard `Request`/`Response`, which is exactly what the MCP SDK v2 entry point consumes (`handler.fetch(c.req.raw, ...)`), so no Node/web conversion layer is needed. It ships an SSE helper, `streamSSE()` in `hono/streaming` ([docs](https://hono.dev/docs/helpers/streaming)), with `stream.aborted` / `onAbort` for client disconnects, and `serveStatic` in `@hono/node-server/serve-static` for the built UI. The MCP SDK v1 itself depends on Hono and `@hono/node-server`, and the MCP project publishes a first-party `@modelcontextprotocol/hono` adapter (2.0.2), so Hono is on the SDK authors' supported path.

**Fastify** 5.12.7 is mature and has a first-party `@modelcontextprotocol/fastify` adapter (2.0.1), but carries about a dozen runtime dependencies and needs extra plugins for static files and SSE. Its Node `req`/`res` model means wrapping the MCP handler with `toNodeHandler` from `@modelcontextprotocol/node`. Reasonable, but more surface for no gain at this size.

**Next.js** 16.4.3 is the wrong shape: it brings a build server, its own routing and server-rendering runtime, and a large install, and it is designed around deployment targets rather than a CLI that starts one process. A read-only UI that needs no server rendering does not use what Next adds.

## MCP SDK

The official TypeScript SDK has two lines ([repo README](https://github.com/modelcontextprotocol/typescript-sdk)):

- **v2** (`@modelcontextprotocol/server` 2.4.0, stable since 2.0.0 on 2026-07-27), the main branch, implementing the [2026-07-28 spec](https://modelcontextprotocol.io/specification/2026-07-28). Split packages: `server`, `client`, plus thin adapters `node`, `express`, `fastify`, `hono`. `server` depends only on `@modelcontextprotocol/core` and `zod ^4.2`; `core` depends only on `zod`.
- **v1** (`@modelcontextprotocol/sdk` 1.32.2) on the `v1.x` branch, receiving bug and security fixes "for at least six months after the v2 release". It bundles Express, Hono, cors, jose, ajv, and more (17 runtime dependencies) into every install.

Use v2. A new project should not start on a line with a published end of support, and v2 is far lighter.

### Streamable HTTP in v2

`createMcpHandler(factory, options)` returns `{ fetch, close, notify, bus }` ([serving guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http); type docs in the package's `createMcpHandler` declarations):

- The factory builds an `McpServer` per request and receives `{ era, authInfo, requestInfo }`. The endpoint is stateless, so no session map to manage.
- It serves the 2026-07-28 revision and, by default, falls back to stateless serving for 2025-era clients (`legacy: 'reject'` turns that off). Keep the default: MCP clients in the wild will speak older revisions for a while.
- Responses are a single JSON body, upgraded to an SSE stream only when a tool emits a notification.
- The entry does no Origin/Host validation and no token verification. Mounting is the host's job: `hostHeaderValidationResponse` / `originValidationResponse` are exported by `@modelcontextprotocol/server` for fetch-style hosts, and `@modelcontextprotocol/hono` adds `localhostHostValidation()` middleware.

Mounting on Hono is one route: `app.all('/mcp', c => handler.fetch(c.req.raw, { authInfo: c.get('auth') }))`.

### Per-Agent bearer tokens

The SDK exports `requireBearerAuth({ verifier, ... })` for fetch-style hosts. It is OAuth-shaped: after the verifier returns `AuthInfo` (`token`, `clientId`, `scopes`, optional `expiresAt`, `resource`), it **rejects any token without a numeric `expiresAt`** ("Token has no expiration time", in `mcp-*.mjs` of `@modelcontextprotocol/server` 2.4.0). agentdash tokens are static and long-lived, so either the verifier sets a far-future `expiresAt`, or agentdash uses its own ten-line Hono middleware. The second is clearer: read `Authorization: Bearer <token>`, look up `sha256(token)` in an `agent_tokens` table, 401 on miss, set `{ token, clientId: agentId, scopes: [] }` and pass it as `authInfo`. Tool handlers then read the Agent from the request context to record "last changed by".

No OAuth authorization server is needed for v1. The SDK's OAuth pieces (`oauthMetadata`, `resourceMetadataUrl`) stay unused.

### Client compatibility (risk)

- **Claude Code** supports static headers on HTTP MCP servers: `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <token>"` ([docs](https://code.claude.com/docs/en/mcp)). This fits per-Agent tokens directly.
- **Claude Desktop** was not verified here. Its remote "custom connectors" historically expect OAuth or no auth and may connect from Anthropic's cloud rather than the local machine, which would not reach a `localhost` server. The common workaround is a local stdio bridge (for example `mcp-remote` with a `--header` flag) configured in `claude_desktop_config.json`. The Destination in the map names Claude Desktop, so this needs its own check before the auth design is final.

## SQLite layer

### Drivers

**`node:sqlite`** (built in). Stability 1.2 "Release candidate" since Node 24.15.0 and 25.7.0; on Node 22 it is still 1.1 "Active development" ([v24 docs](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [current docs](https://nodejs.org/api/sqlite.html)). Synchronous API (`prepare`, `run`, `get`, `all`, `exec`, transactions via SQL), bundled SQLite 3.53.2 on Node 26.4, no `ExperimentalWarning` printed on load on 26.4. Zero install cost and nothing native to break under `npx`.

Churn to plan for: Node 26.11 renamed the class `DatabaseSync` to `Database` and kept `DatabaseSync` as a documentation-only deprecated alias ([DEP0210](https://nodejs.org/api/deprecations.html#dep0210-sqlitedatabasesync)). Node 24 only has `DatabaseSync`. Import `DatabaseSync` (works on both) inside one storage module and switch later.

**`better-sqlite3`** 13.0.3. Since 13.0.0 it is built on N-API and ships prebuilt binaries inside the npm package for linux x64/arm64 (glibc and musl), darwin x64/arm64, and win32 x64/arm64; `prebuild-install` is gone and it compiles from source only on platforms without a prebuild ([v13.0.0 release notes](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)). That removes most of the historic native-module pain for `npx`, at the cost of a 27 MB unpacked install and `engines.node >=22`. It is the fallback if `node:sqlite` blocks something; with the storage module in place the swap is one file.

### Query layer

**Drizzle**: stable `drizzle-orm` 0.45.4 has no `node:sqlite` driver; that exists only on the 1.0 pre-release line (`1.0.0-rc.5`, plus `node-sqlite` dist-tags). With `better-sqlite3` it works on 0.45, and `drizzle-kit` would generate migrations. Adding it means a schema DSL, a dev CLI, and an ORM still mid-way to 1.0.

**Kysely** 0.29.8 is a lighter query builder, but has no built-in `node:sqlite` dialect.

**Plain SQL**: the domain is a handful of tables (Area, Dashboard tree, Widget, Agent, token, possibly a data series). Hand-written prepared statements in one module, row types declared in TypeScript, and migrations as an ordered array of SQL strings applied by comparing against `PRAGMA user_version` cover this with no dependency. Recursive CTEs handle the Dashboard tree. This is the recommendation; revisit Drizzle once it ships 1.0 with `node:sqlite` support if the schema grows.

Settings to apply on open: `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout`. One process owns the file, so the synchronous API does not block anything meaningful at single-Owner scale.

## Frontend build

React + Vite, built during `npm publish` (`prepublishOnly`) into `dist/web`, served as static files by the same Hono app with an SPA fallback to `index.html`. The browser opens one `EventSource('/events')` for live updates; the UI reads JSON from read-only `/api/*` routes. Vite 8.3.5 requires Node `^20.19 || >=22.12` for building only, which does not affect installed users. Preact or plain web components would cut bundle size further, but React is the more boring choice for chart libraries and for agent-written UI code; this is a frontend-only decision that does not affect the server stack.

## Packaging notes for `npx agentdash`

- `package.json`: `"bin": { "agentdash": "dist/cli.js" }`, `"type": "module"`, `"engines": { "node": ">=24.15" }`, `"files": ["dist"]`.
- Compile the server with `tsc` (or a bundler such as tsdown) to `dist/`; ship no TypeScript at runtime.
- No install scripts and no native code means `npx` installs are a plain download.
- TypeScript 6 no longer auto-includes `@types/*`; the MCP SDK README notes that `"types": ["node"]` is needed in `tsconfig.json`.

## Risks and open questions

1. **Claude Desktop auth path** (above). Static bearer tokens fit Claude Code directly; Claude Desktop may need a stdio bridge or OAuth. Check before closing the auth design.
2. **`node:sqlite` is release candidate, not stable**, and has already renamed its main class once. Contained by keeping all SQL in one module, with `better-sqlite3` 13 as a drop-in fallback.
3. **MCP SDK v2 is three months old** (2.0.0 on 2026-07-27, 2.4.0 on 2026-10-23). Expect minor-version API additions; pin a caret range and keep the MCP wiring in one file.
4. **Node floor of 24.15** excludes Node 22 (maintenance LTS until 2027-04-30). Acceptable for a new tool; the CLI should print a clear message on older Node instead of a stack trace.
5. **DNS rebinding**: a localhost server with no Host/Origin checks can be driven by a malicious web page. Apply `localhostHostValidation()` (or the SDK's `hostHeaderValidationResponse`) to `/mcp` and the read API, plus the bearer check on `/mcp`.

## Sources

- npm registry metadata (`npm view`) for every package and version above, 2026-11-01.
- MCP TypeScript SDK README: https://github.com/modelcontextprotocol/typescript-sdk
- MCP SDK v2 serving guide: https://ts.sdk.modelcontextprotocol.io/v2/serving/http
- `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2, `@modelcontextprotocol/hono` 2.0.2 package READMEs and type declarations (from `npm pack`).
- Node.js `node:sqlite` docs: https://nodejs.org/api/sqlite.html and https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- Node.js deprecation DEP0210: https://nodejs.org/api/deprecations.html#dep0210-sqlitedatabasesync
- Node.js release schedule: https://github.com/nodejs/Release/blob/main/schedule.json
- better-sqlite3 v13.0.0 release: https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0 and `package.json` at v13.0.3
- Hono streaming helper: https://hono.dev/docs/helpers/streaming
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp
