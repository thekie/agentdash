# Coding standards

Rules that Biome, `tsc` and the coverage threshold cannot check. Anything they check is out of scope for review: casing follows Google's TypeScript style guide through Biome's `useNamingConvention`, and Biome rejects `export *`, non-null `!` and unsafe `as`.

## Shape

- **Domain terms.** Name code after `CONTEXT.md`. Never use a term it lists under _Avoid_.
- **Types before tests.** If a type can make a mistake impossible, use the type. Delete a runtime guard for a case the types already rule out, and its test with it.
- **Parse at the boundary.** Data from outside (MCP tool input, HTTP requests, SQLite rows) is parsed once where it enters, with zod. Inside, trust the types. No `@ts-expect-error` to quiet the compiler.
- **Logic in pure functions.** Hono and MCP handlers parse, call, and translate the result. The decisions they call live in functions with no I/O.
- **Idempotent tools.** Repeating an MCP tool call, or retrying it after a crash, ends in the same state.
- **A type describes the thing.** Keep the cases of a thing in a union. Compose object types with `extends`; use `&` only to join an object type to a union.
- **Layers meet through an interface.** The UI, the MCP tools and storage reach each other only through what each one exports.
- **SQL lives in the storage module.** No SQL strings elsewhere.
- **MCP wiring stays in one place:** `src/app.ts` and the tool modules it registers.
- **Fix the cause.** A guard that only stops a crash from showing is not a fix.

## Names

- Use the word the library already uses: `close` for the MCP handler, `createX` for a factory as in `createRoot` and `createMcpHandler`.
- A function that returns a value and changes nothing is named for the value: `oversizedUploads`. Exceptions follow TypeScript idiom: a factory is `createX`, a boundary parser is `parseX`, a type guard is `isX`.
- A function that changes something gets a verb and an object: `archiveWidget`.
- A boolean starts with `is`, `has`, `can` or `should`. A collection name is plural.
- A file name says what the file holds. No `utils`, `helpers`, `common`, `misc` or `shared`.
- No vague verbs: `handle`, `process`, `manage`, `perform`, `do`. If an accurate name is long, split the function.
- One thing gets one word everywhere. Two sides of one thing get the same shape: `archiveWidget` and `restoreWidget`.

## Tests

- **Test through the interface.** MCP behaviour is tested with the SDK client against the real handler, UI behaviour with Playwright against the running app. Assert only what a caller can observe: the return value or state it can read back. No assertions on SQLite rows or private functions.
- **Lowest layer that catches it.** Test each behaviour once, at the cheapest layer. Write a Playwright test only for what only a browser can reach.
- **One behaviour per test.** Tests sit at the top level of the file with no `describe`. The title states one behaviour. Variants are rows of `test.for`.
- **A test builds its own state.** It writes what it needs under a temporary directory or a fresh in-memory database and removes it afterwards.
- **Break a new guard once.** Add the violation a new test, type or lint must catch, see it fail, then remove the violation.
- **A test must be able to fail.** Delete a test that would still pass if the function under test returned nothing.

## Comments and docstrings

These rules apply to comments, docstrings and error messages.

### Words

- Write plain technical English. Use short sentences of no more than 25 words, with one fact in each sentence. If a sentence needs a second reading, split it.
- Use the active voice. The passive is permitted when the actor is the system and naming it adds nothing.
- Use "can" and "must", not "may" or "should". Write "for example", not "e.g.". Do not use contractions, semicolons or em-dashes.
- Use the terms of `CONTEXT.md` with their capitals. Write code in backticks, and do not use it as a verb.
- Do not name the product in code, comments or messages.
- Describe the present. Do not write history ("previously", "now", "changed") or issue and pull request numbers.
- Write the plain sentence that says what happens. Do not write an antithesis for rhythm ("not X, but Y"), a maxim, or a closing line written to be quoted.

### Docstrings

- Every export has a docstring. A declaration that is not exported has none if its name and signature already say what it does. A Zod schema and the type of the same name share one docstring, on the schema.
- A docstring states the contract in one to three sentences: what the declaration does or returns, and when it fails. It does not say how the body works or why the code has this shape. That goes in the pull request.
- Do not add `@param` or `@returns` tags that repeat the signature.
- Open on the verb for the kind of declaration. The declaration is the subject, and the docstring leaves it out.

| Declaration                            | Verb                                                                                    | Example                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A function that computes a value       | Returns                                                                                 | `Returns the live rows of a Data Store.`                  |
| A function that computes true or false | Reports whether                                                                         | `Reports whether the Dashboard is under an Archived one.` |
| A function that you call for a change  | the verb of the change: creates, adds, writes, moves, archives, restores, opens, closes | `Archives a Widget and its subtree.`                      |
| A type or an interface                 | Describes, represents, or a noun phrase                                                 | `Describes a Widget as an Agent writes it.`               |
| A constant or a property               | Is, or a noun phrase                                                                    | `The most rows that one append can carry.`                |

- If a function can throw, say when with "if", and name each error code that a caller checks for: "Throws `StorageError` `conflict` if a sibling has the slug."

### Comments

- Before you write a comment, name the wrong belief that it prevents. If you cannot name it, write nothing. If a name can hold it, rename the thing instead.
- These comments fail the test: one that restates a boundary the code enforces, one that describes what a declaration declares, and one that records a decision.
- These comments pass: a library that behaves unexpectedly, a value that is always the same for a reason, a rule that is enforced in a different place, and a shortcut with the point where it stops working.
- After you change code, read the comment or docstring above it again.
- A hook in `.claude/hooks/comment-length.py` reminds an agent of these rules when an edit adds a comment of more than three lines.
