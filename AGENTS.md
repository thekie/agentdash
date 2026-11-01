# agentdash

A self-hosted dashboard written by AI agents over MCP and read by one human in the browser. One Node process serves the web UI and the MCP endpoint.

- **Glossary:** [CONTEXT.md](CONTEXT.md). Use its terms (Owner, Agent, Area, Dashboard, Widget, Data Store, Projection). Skills that look for `GLOSSARY.md` (such as `/tdd`) should read `CONTEXT.md`.
- **Plan and decisions:** the [Map: agentdash v1](https://github.com/thekie/agentdash/issues/1) issue and its child tickets. Decisions live in closed tickets; there are no ADRs.
- **Standards:** [CODING_STANDARDS.md](CODING_STANDARDS.md) holds the rules tooling cannot check.

## Layout

- `src/main.ts`: CLI entry (`--port`, `--data-dir`), binds `127.0.0.1` only
- `src/app.ts`: Hono app, `/mcp` (MCP SDK v2 `createMcpHandler`), static web UI
- `web/`: React UI, built by Vite to `dist/web`
- `e2e/`: Playwright specs against the running app

## Commands

- `npm run check`: Biome, `tsc`, Vitest. Run before every commit (the pre-commit hook runs Biome and `tsc`).
- `npm run e2e`: builds the UI and runs Playwright against a real server.
- `npm run dev`: server with `--watch`, data in `.data/dev`.
- `npm run fix`: Biome autofix.

Node 26 runs the `.ts` files directly; `tsc` only typechecks. Always pass `--data-dir` under `.data/` when running the app for tests or verification, so the Owner's data in `~/.agentdash` is never touched.
