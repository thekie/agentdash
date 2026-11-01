# Coding standards

Rules that Biome, `tsc` and the CRAP gate cannot check. Anything they check is out of scope for review.

## Shape

- **Domain terms.** Name code after `CONTEXT.md`. Never use a term it lists under _Avoid_.
- **Types before tests.** If a type can make a mistake impossible, use the type. Delete a runtime guard for a case the types already rule out, and its test with it.
- **Parse at the boundary.** Data from outside (MCP tool input, HTTP requests, SQLite rows) is parsed once where it enters, with zod. Inside, trust the types. No `as`, `!` or `@ts-expect-error` to quiet the compiler.
- **Logic in pure functions.** Hono and MCP handlers parse, call, and translate the result. The decisions they call live in functions with no I/O.
- **Idempotent tools.** Repeating an MCP tool call, or retrying it after a crash, ends in the same state.
- **A type describes the thing.** Keep the cases of a thing in a union. Compose object types with `extends`; use `&` only to join an object type to a union.
- **Layers meet through an interface.** The UI, the MCP tools and storage reach each other only through what each one exports.
- **SQL lives in the storage module.** No SQL strings elsewhere.
- **MCP wiring stays in one place:** `src/app.ts` and the tool modules it registers.
- **Name each export.** No `export *`.
- **Fix the cause.** A guard that only stops a crash from showing is not a fix.

## Names

- A file name says what the file holds. No `utils`, `helpers`, `common`, `misc` or `shared`.
- A function that returns a value and changes nothing is named for the value. A function that changes something gets a verb and an object.
- No vague verbs: `handle`, `process`, `manage`, `perform`, `do`. If an accurate name is long, split the function.
- One thing gets one word everywhere. Two sides of one thing get the same shape: `archiveWidget` and `restoreWidget`.

## Tests

- **Test through the interface.** MCP behaviour is tested with the SDK client against the real handler, UI behaviour with Playwright against the running app. Assert only what a caller can observe: the return value or state it can read back. No assertions on SQLite rows or private functions.
- **Lowest layer that catches it.** Test each behaviour once, at the cheapest layer. Write a Playwright test only for what only a browser can reach.
- **One behaviour per test.** Tests sit at the top level of the file with no `describe`. The title states one behaviour. Variants are rows of `test.for`.
- **A test builds its own state.** It writes what it needs under a temporary directory or a fresh in-memory database and removes it afterwards.
- **Break a new guard once.** Add the violation a new test, type or lint must catch, see it fail, then remove the violation.
- **A test must be able to fail.** Delete a test that would still pass if the function under test returned nothing.

## Comments

- An exported function states its contract in one to three sentences: what it does or returns, and when it fails. No `@param` or `@returns` that repeat the signature.
- Write a comment only when you can name the wrong belief it prevents. If a rename can carry it, rename instead.
- The reason for a design goes in the pull request, not in a comment.
