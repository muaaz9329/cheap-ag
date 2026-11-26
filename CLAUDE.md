## Code style & refactor rules

This package has live users. A refactor must not change behavior.
Tools check formatting and lint. These rules cover what tools cannot check.

### MUST (always)

1. Keep behavior the same. Do not change public exports, CLI output, exit codes, or
   user-facing message text. Keep every character, space, and newline.
2. Refactor one module per PR. Do not mix a refactor and a behavior change in one commit.
3. Before you change a module, check that tests cover its behavior. If they do not,
   add characterization tests first. Commit those tests alone.
4. Run `npm run check` after each small step. All tests must pass.
   Do not change the expected values of an existing test to make it pass.
5. Give each function one job. Name the function for that job. If the name needs
   "and", split the function.
6. Do not nest ternaries. Use `if`/`else`, an early `return`, or a lookup table.
7. Write one idea per line. If Prettier cannot fit a line in 100 characters, move part
   of the expression into a named `const`.
8. Use whole words in names. Allowed short forms: id, url, cli, mcp, json, env, config.
9. Write comments that explain why. Do not explain what the code does. Remove ticket
   numbers and change history from comments. Put them in the commit message.
10. Handle errors explicitly. Do not write an empty `catch`. Do not swallow an error.
    Keep the error class and the message text.
11. Do not add dependencies. Do not change `tsconfig.json`, `package.json` exports,
    or build config in a refactor PR.
12. Do not disable a lint rule inline unless a comment on the same line says why.

### SHOULD (default, break with a reason)

- Keep a function under about 40 lines. Split by responsibility, not by line count.
- Do not create tiny helpers that need many parameters. Keep modules deep: simple
  interface, real work inside.
- Keep nesting at 3 levels or less. Use guard clauses and early returns.
- Use 3 parameters or fewer for new internal functions. Use an options object for more.
  Do not change signatures that are exported.
- Validate untrusted input (config files, CLI args, MCP requests, env) once, at the
  boundary. Take `unknown`, return a typed value. Use a small guard per field.
- Use `const` by default. Use `unknown`, not `any`.
- Use function declarations for named functions.
- Use named exports in new internal code. Export only what other modules use.
- Do not add barrel `index.ts` files. `src/index.ts` is the public entry. Keep it.
- Use relative imports. Avoid more than one `../`.
- Keep `try` blocks small. Wrap only the call that can fail.
- Put constants and magic strings in named `const`s near their use.

### Refactor procedure (per module)

1. Read the module and its tests. List its exports and their callers (`grep`).
2. List every user-facing string in the module: errors, logs, CLI text.
3. Add characterization tests where coverage is missing: CLI output, error text,
   return values, file writes. Run them. Commit: `test(<module>): pin current behavior`.
4. Make one small change. Examples: rename a local, extract a function, replace a
   nested ternary, add a guard clause, split a long line into named consts.
5. Run `npm run check`. If it fails, undo the step. Do not fix forward.
6. Commit each logical step: `refactor(<module>): <what changed>`.
7. Repeat steps 4–6 until the done-checklist passes.
8. Open one PR for the module. Say "no behavior change" in the description.

### Done-checklist (verify before you finish a module)

- [ ] `npm run check` passes: format, lint, typecheck, all tests.
- [ ] No existing test assertion changed. Only new tests were added.
- [ ] `scripts/check-strings.sh` prints nothing (no user-facing string removed or changed).
- [ ] The public API diff is empty (`npm run api:check`).
- [ ] No new dependency. No change to tsconfig, package exports, or build config.
- [ ] No nested ternary. No empty catch. No inline lint disable without a reason.
- [ ] No ticket numbers or history in comments.
- [ ] Each function in the module has one job and a whole-word name.
- [ ] The PR touches one module and its tests only.
