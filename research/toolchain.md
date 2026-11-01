# Lint, test, and CI toolchain for agent-driven development

Research for the ticket "Which lint, test, and CI toolchain best supports agent-driven development here?" (map: agentdash v1). Facts checked against primary sources on 2026-11-01; versions are the npm `latest` tags on that date.

## Recommendation

Six dev dependencies, one script that runs everything, and one CI workflow with two jobs:

| Concern | Pick | Version (2026-11-01) |
| --- | --- | --- |
| Runtime | Node 26 (Active LTS since 2026-10-28), running `.ts` directly via built-in type stripping | 26.13.0 |
| Typecheck | `typescript` 7 (native Go `tsc`), `strict` plus a few extra flags, `noEmit` | 7.0.2 |
| Lint + format | Biome (one binary), with the `types` and `test` domains on and `noFloatingPromises` enabled | 2.6.4 |
| Unit + integration tests | Vitest | 5.0.5 |
| MCP in tests | `@modelcontextprotocol/client` (SDK v2) driving the real `createMcpHandler` in-process | 2.4.0 |
| MCP smoke against the running app | MCP Inspector CLI, pinned exact version | 2.13.0 |
| Browser | `@playwright/test` for committed specs; `@playwright/cli` for agents driving the UI ad hoc inside the verify skill | 1.64.1 / 0.1.23 |
| Pre-commit | A plain shell hook in `.githooks/` (`git config core.hooksPath .githooks`), no hook manager | none |
| Agent hook | Claude Code `PostToolUse` hook running `biome check --write` on the edited file | none |
| CI | GitHub Actions: job `check` (biome ci, tsc, vitest) and job `e2e` (build, start, Inspector smoke, Playwright), `concurrency` with `cancel-in-progress` | checkout v7, setup-node v7 |

One entry point for agents and CI alike:

```jsonc
// package.json (sketch)
"scripts": {
  "check": "biome ci . && tsc && vitest run",
  "fix": "biome check --write .",
  "test": "vitest",
  "e2e": "playwright test",
  "verify": "npm run check && npm run e2e"
}
```

The rest of this file is the evidence and the reasoning per layer.

## Feedback loops, inner to outer

| Loop | Trigger | Tool | What it catches |
| --- | --- | --- | --- |
| 1. Per edit | Agent `Edit`/`Write` | Claude Code hook: `biome check --write <file>` | Formatting, autofixable lint, import order; reported back to the agent on failure |
| 2. Per red/green cycle | `/tdd` loop | `vitest` (watch or `vitest run <file>`) | Behavior at agreed seams; MCP tools through a real client |
| 3. Per commit | git `pre-commit` | `biome check --staged` + `tsc` | Anything loop 1 missed, type errors across files |
| 4. Per change, before closing | `verify-agentdash` skill + `/code-review` | Playwright, Inspector CLI or SDK client script, SQLite readback | Real user path in the running app; spec and standards drift |
| 5. Per push / PR | GitHub Actions | `npm run check`, then e2e job | Everything above on a clean machine |

## Typecheck: TypeScript 7

- TypeScript 7.0 (released 2026-07-08) is the native Go port, "typically yield[ing] speedups between 8x and 12x on full builds". It ships as the `typescript` package with a `tsc` binary and per-platform native packages. [TS 7.0 announcement; npm `typescript@7.0.2`]
- `strict` is on by default in 7.0, `module` defaults to `esnext`, `types` defaults to `[]` and `rootDir` to `./`; `baseUrl`, `moduleResolution: node10`, `target: es5` are hard errors. [TS 7.0 announcement]
- 7.0 ships **without a programmatic API**; a new API is expected in 7.1. Tools that import `typescript` (notably typescript-eslint) must stay on 6.0 via the `@typescript/typescript6` compatibility package and an npm alias. [TS 7.0 announcement] typescript-eslint 8.72.1 declares `typescript: ">=4.8.4 <6.1.0"` as its peer range. [npm `typescript-eslint@8.72.1`]
- Node 26 runs `.ts` files natively (type stripping is stable and on by default). It requires erasable-only syntax: no enums, no runtime namespaces, no parameter properties, no `paths`, no decorators; type imports need `import type`. Node's recommended tsconfig: `noEmit`, `target: esnext`, `module: nodenext`, `rewriteRelativeImportExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`. [Node 26 TypeScript docs]

Suggested `tsconfig.json` additions on top of those: `"types": ["node"]` (needed because of the 7.0 default), `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. These are judgment calls aimed at forcing agents to handle `undefined` explicitly; they cost nothing at runtime.

Consequences for agentdash:

- Dev loop needs no `tsx` or bundler: `node --watch src/main.ts`.
- `tsc` is purely a checker in dev. The published package still needs a build step, because Node refuses to type-strip files under `node_modules`. [Node 26 TypeScript docs] That is a packaging-ticket concern ("Packaging and release" on the map), not a toolchain one.

## Lint + format: Biome over ESLint/Prettier

Why Biome:

- **Fewest tools.** One binary does format, lint, and import sorting; `biome ci` is the read-only CI mode, and on GitHub "the diagnostics are printed using the GitHub annotations". First-party action `biomejs/setup-biome@v2` exists. [Biome CI recipe]
- **Works with TS 7 today.** Biome's type-aware rules use its own inference engine (enable `"linter": {"domains": {"types": "recommended"}}`), so they do not depend on the TypeScript API that 7.0 lacks. [Biome domains; Biome noFloatingPromises] ESLint type-aware linting via typescript-eslint would force a second TypeScript install (6.0 alias) next to 7.0. [TS 7.0 announcement; npm `typescript-eslint`]
- **Floating promises.** `noFloatingPromises` is the rule that matters most for an async server written by agents. In Biome it is a nursery rule (since v2.0.0, behavior may change) and must be enabled explicitly under `linter.rules.nursery`. [Biome noFloatingPromises] Accept the nursery status; Vitest 5 also fails tests with unawaited async assertions, which covers the test side. [Vitest 5 announcement]
- The `test` domain switches on automatically when `vitest` is a dependency; the `project` domain adds `noImportCycles` and `noUnresolvedImports` at the cost of a full-project scan. [Biome domains] Turn on `project` too; the repo is small.

Named fallback: if Biome's inference misses real bugs, **oxlint with `--type-aware`** runs typescript-eslint's type-aware rules on typescript-go ("59 out of 61"), and `--type-check` can even report TypeScript errors in the same pass. [Oxlint type-aware docs] It needs `oxlint` + `oxlint-tsgolint` + a separate formatter (`oxfmt` 0.75.0, pre-1.0), so it is three tools where Biome is one. [npm]

## Unit and integration tests: Vitest 5

- Vitest 5.0 (2026-09) requires Node >= 22.12 and Vite >= 6.4; `clearMocks` defaults to `true`, and unawaited async assertions fail the test. [Vitest 5 announcement; npm `vitest@5.0.5`]
- **Agent-legible output out of the box**: the `minimal` reporter (alias `agent`) "is enabled automatically when Vitest detects it is running inside an AI coding agent" and prints only failed tests and their errors. The `github-actions` reporter is added automatically when `GITHUB_ACTIONS=true`, producing inline PR annotations. [Vitest reporters]
- SQLite in tests: each test opens a fresh in-memory database through the same storage module production uses. `/tdd`'s mocking guide says mock only at system boundaries and "prefer test DB" for databases. [mattpocock/skills `tdd/mocking.md`]

`node:test` would remove one dependency, but it lacks the automatic agent reporter, the GitHub annotations, and Vitest's watch/filter ergonomics. Vitest earns its slot.

## Driving the MCP server

Three levels, each with one tool:

1. **In-process, in Vitest (default for `/tdd`).** SDK v2 is the stable line (split packages `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, implementing the 2026-07-28 spec); v1 (`@modelcontextprotocol/sdk`) gets fixes for at least six months after v2's 2026-07-27 release. [typescript-sdk README] The SDK's own testing guide: build the server with `createMcpHandler(createServer)`, then pass `fetch: (url, init) => handler.fetch(new Request(url, init))` to a `StreamableHTTPClientTransport`. "One `Client` plus one `createMcpHandler` is a complete no-socket integration test of the server you deploy." Assert on `structuredContent`; tool failures come back as `isError: true`, not thrown errors. Close client, then handler, in `afterEach`. [typescript-sdk `docs/testing.md`]
2. **Legacy-client coverage.** Claude Code and Claude Desktop may still speak 2025-era revisions. `createMcpHandler` serves those by default (`legacy: 'stateless'`); `InMemoryTransport.createLinkedPair()` only connects 2025-era instances, while `handler.fetch` is the entry for 2026-07-28. [typescript-sdk `docs/serving/legacy-clients.md`, `docs/testing.md`] Add one test that connects with a 2025-era protocol version so a regression for older agents fails CI.
3. **Against the running process (CI smoke + verify skill).** The Inspector CLI is "a scriptable command-line client for automation, CI, and fast agent feedback loops": `npx --yes @modelcontextprotocol/inspector@<exact> --cli --transport http --server-url http://127.0.0.1:<port>/mcp --method tools/list --format json | jq -e ...`. `--method initialize` is a connect-only probe; stdout is the result and stderr diagnostics; always set `--connect-timeout`; pin an exact version in CI because `@2` is not a pin. `tools/list --strict` reports schema portability findings. [Inspector README; Inspector `docs/cli-smoke-testing.md`] For multi-step journeys inside the verify skill (create Area, add Dashboard, append data, read back), a small committed TypeScript script using the same SDK client is clearer than chained CLI calls, and it runs with plain `node`.

Assert through the MCP interface in tests, and read SQLite back only in the verify skill. `/tdd` lists "verifies through a side channel (querying the database instead of using the interface)" as an anti-pattern [mattpocock/skills `tdd/SKILL.md`], while pstack's evidence standard asks to "verify side effects (files written, rows inserted ...) alongside what's visible" [pstack `create-verification-skill`]. Both hold if each applies at its own layer.

## Driving the web UI: Playwright

- **Committed specs**: `@playwright/test` with `webServer` starting the real app (`reuseExistingServer: !process.env.CI`). [Playwright webServer docs] Chromium only; in CI `npx playwright install --with-deps --only-shell` skips the full browser when tests run headless. [Playwright browsers docs] Do not cache browser binaries: restoring takes about as long as downloading, and OS deps are not cacheable. [Playwright CI docs] Upload `playwright-report/` with `if: ${{ !cancelled() }}`; use `globalTimeout` in config rather than job-level `timeout-minutes`. [Playwright CI intro]
- **Ad hoc driving by agents**: `@playwright/cli` (`playwright-cli open|snapshot|click e15|screenshot`) is built for coding agents and avoids loading MCP tool schemas and full accessibility trees into context. [Playwright CLI docs] Use it in the verify skill's "Driving it" sections for exploratory proofs; promote a journey to a committed spec when it should guard against regressions.
- **Live updates**: Playwright's web-first assertions retry until timeout, so a test can make an MCP write through the SDK client and then `expect(page.getByRole(...)).toBeVisible()` to prove the SSE path end to end.
- Playwright's Test Agents (`npx playwright init-agents --loop=claude`: planner, generator, healer) are optional. They overlap with the verify skill's feature map and must be regenerated on each Playwright upgrade. [Playwright test agents] Skip them for v1.

## Where the skills slot in

| Step | Skill | Toolchain touchpoint |
| --- | --- | --- |
| Pick and frame a ticket | `/wayfinder` (map = issue #1) | none |
| Build logic | `/tdd`: agree seams, then red/green one slice at a time; refactoring belongs to review | `vitest` (agent reporter), SDK client in-process |
| Prove the change in the real app | `verify-agentdash` (generated once by pstack `/create-verification-skill`) | `node src/main.ts` launch, doctor via Inspector `--method initialize`, Playwright CLI/specs, SDK script, SQLite readback |
| Review before closing | `/code-review` (Standards + Spec sub-agents) | Reads `CODING_STANDARDS.md`/`CONTRIBUTING.md`; told to "skip anything tooling enforces" |
| Keep the map honest | pstack `/maintain-verification-skill`, periodic | Edits only the verify skill directory; product regressions get reported, not papered over |

Concrete notes from the skill sources:

- **pstack paths in Claude Code.** pstack writes `.cursor/skills/verify-<app>/`; its Claude Code adapter maps `.cursor/skills/` to `.claude/skills/`. So the skill lives at `.claude/skills/verify-agentdash/` with `features/README.md` plus one file per feature, using the four H2s `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, `Gotchas`. The generated skill needs Launch (ready from an empty data dir, migrations included), Doctor, Drive, Evidence, Cleanup, Helpers, and must be executed end to end once before it counts. [pstack `create-verification-skill`; pstack Claude Code adapter] Two consequences for the toolchain: the app needs a `--data-dir`/`--port` flag so verification instances are isolated from the Owner's real data, and a read-only health endpoint or MCP `initialize` serves as Doctor.
- Both pstack skills are `disable-model-invocation: true`, so a human or the map ticket has to invoke them. [pstack skill frontmatter]
- **`/code-review` and lint.** Its Standards axis carries a Fowler smell baseline and skips "anything tooling already enforces". [mattpocock/skills `code-review/SKILL.md`] Every rule Biome and `tsc` enforce is one the reviewer does not spend tokens on, so a short `CODING_STANDARDS.md` should hold only what tooling cannot check (erasable-syntax-only, domain terms from `CONTEXT.md`, test-at-seams).
- **`/tdd` looks for `GLOSSARY.md`**; this repo's glossary is `CONTEXT.md`. Either add a one-line `GLOSSARY.md` pointer or note it in `CLAUDE.md`/`AGENTS.md`. [mattpocock/skills `tdd/SKILL.md`]

## Hooks

- **Claude Code `PostToolUse` hook** with matcher `Edit|Write` running a formatter on `tool_input.file_path` is the documented pattern; exit code 2 with a reason on stderr feeds it back to Claude. [Claude Code hooks guide] Use `npx biome check --write --no-errors-on-unmatched "$file"` so autofixable issues never reach a review. Commit it in `.claude/settings.json`.
- **git pre-commit**: Biome documents a plain `#!/bin/sh` hook running `biome check --staged --files-ignore-unknown=true --no-errors-on-unmatched`. [Biome git hooks recipe] Put it in `.githooks/pre-commit` with `tsc` after it, and set `core.hooksPath` from a `prepare` script. No husky or lefthook: one fewer dependency, and agents that bypass hooks are still caught by CI.

## GitHub Actions layout

One workflow, two jobs, triggered on `pull_request` and `push` to `main`:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npx biome ci .
      - run: npx tsc
      - run: npx vitest run
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps --only-shell
      - run: npm run e2e  # webServer starts the app; a globalSetup or first spec runs the Inspector smoke
      - uses: actions/upload-artifact@v7
        if: ${{ !cancelled() }}
        with: { name: playwright-report, path: playwright-report/, retention-days: 14 }
```

- The jobs run in parallel; `e2e` does not wait on `check`, so total wall time is the slower of the two.
- `cancel-in-progress: true` cancels running jobs in the same group, which keeps agent force-pushes from queueing stale runs. Setting any `permissions` key drops unspecified scopes to `none`. [GitHub workflow syntax]
- Steps are separate so a red check names the failing layer in the PR UI; Biome and Vitest both emit GitHub annotations without extra flags. [Biome CI recipe; Vitest reporters]
- Action major versions above are the latest releases on 2026-11-01 (checkout v7.0.1, setup-node v7.1.0, upload-artifact v7.0.2). [GitHub releases API] Playwright's own docs still show older majors.
- Public repo: standard GitHub-hosted runners are free, which is the reason the map gives for building in public.

## Rejected or deferred

- **ESLint + Prettier + typescript-eslint**: three tools plus a TypeScript 6 alias next to 7.0 until TS 7.1 ships an API.
- **husky / lefthook**: a hook manager adds nothing over a committed `.githooks/` dir for one hook.
- **knip, coverage thresholds, mutation testing**: not needed before product code exists; revisit once the codebase grows.
- **Playwright Test Agents, Playwright MCP**: overlap with the verify skill and the leaner `playwright-cli`.
- **tsx**: Node 26 runs erasable TypeScript directly.

## Risks to watch

- Biome's `noFloatingPromises` is nursery and inference-based; if it misses cases, switch the linter to oxlint `--type-aware` (keep Biome as formatter or move to oxfmt).
- TypeScript 7.1 will bring an API; re-check typescript-eslint and editor tooling then.
- Erasable-syntax-only is a hard constraint for agents (no enums, no parameter properties). `erasableSyntaxOnly` in tsconfig makes `tsc` reject violations, so loop 3 catches them.
- SDK v2 is three months old; pin exact versions and let the 2025-era client test catch protocol regressions.

## Sources

- TypeScript 7.0 announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- npm registry metadata (`npm view`) for typescript, typescript-eslint, @biomejs/biome, vitest, oxlint, oxfmt, @modelcontextprotocol/*, @playwright/*: https://www.npmjs.com/
- Node.js 26 TypeScript docs: https://nodejs.org/docs/latest-v26.x/api/typescript.html
- Node.js release schedule: https://github.com/nodejs/Release/blob/main/schedule.json
- Biome CI recipe: https://biomejs.dev/recipes/continuous-integration/
- Biome git hooks recipe: https://biomejs.dev/recipes/git-hooks/
- Biome linter domains: https://biomejs.dev/linter/domains/
- Biome noFloatingPromises: https://biomejs.dev/linter/rules/no-floating-promises/
- Oxlint type-aware linting: https://oxc.rs/docs/guide/usage/linter/type-aware.html
- Vitest 5 announcement: https://vitest.dev/blog/vitest-5
- Vitest reporters: https://vitest.dev/guide/reporters
- MCP TypeScript SDK README (v2): https://github.com/modelcontextprotocol/typescript-sdk
- MCP TS SDK testing guide: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md
- MCP TS SDK connect guide: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md
- MCP TS SDK legacy clients: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md
- MCP Inspector README: https://github.com/modelcontextprotocol/inspector
- MCP Inspector CLI smoke testing: https://github.com/modelcontextprotocol/inspector/blob/main/docs/cli-smoke-testing.md
- Playwright CI intro: https://playwright.dev/docs/ci-intro
- Playwright CI (browser caching): https://github.com/microsoft/playwright/blob/main/docs/src/ci.md
- Playwright browsers (`--only-shell`): https://playwright.dev/docs/browsers
- Playwright webServer: https://playwright.dev/docs/test-webserver
- Playwright CLI: https://playwright.dev/docs/getting-started-cli
- Playwright Test Agents: https://playwright.dev/docs/test-agents
- Claude Code hooks guide: https://code.claude.com/docs/en/hooks-guide
- GitHub Actions workflow syntax: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- mattpocock/skills (at 4ae2317): `skills/engineering/tdd/SKILL.md`, `tdd/mocking.md`, `code-review/SKILL.md`, `wayfinder/SKILL.md`: https://github.com/mattpocock/skills
- cursor/plugins pstack (at ae5650f): `harness/pstack/claude-code/skills/create-verification-skill/SKILL.md`, `maintain-verification-skill/SKILL.md`, `docs/harness/claude-code.md`, `docs/guide/06-verify-and-ship.md`: https://github.com/cursor/plugins/tree/main/harness/pstack
