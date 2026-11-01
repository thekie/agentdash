# agentdash

A self-hosted dashboard written by AI agents over MCP and read by one human in the browser. One Node process serves the web UI and the MCP endpoint.

- **Glossary:** [CONTEXT.md](CONTEXT.md). Use its terms (Owner, Agent, Area, Dashboard, Widget, Data Store, Projection). Skills that look for `GLOSSARY.md` (such as `/tdd`) should read `CONTEXT.md`.
- **Source of truth:** the code, its tests and `CONTEXT.md` say what agentdash does. The reason for a choice goes in the pull request description and the commit message, where `git log` and `git blame` find it. There are no ADRs. A rule that agents keep breaking goes into a type, a test or a lint first, and into `CODING_STANDARDS.md` only when no check can hold it.
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

CI also fails when any function in `src/` scores above 10 on CRAP (complexity weighted by missing test coverage, from `unclebob/crapper`). Split the function, test it, or both.

Each commit message says why, what changed, and how you proved it.

Node 26 runs the `.ts` files directly; `tsc` only typechecks. Always pass `--data-dir` under `.data/` when running the app for tests or verification, so the Owner's data in `~/.agentdash` is never touched.
