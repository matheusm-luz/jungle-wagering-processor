---
description: Harness check. Run typecheck, lint and every test suite and report the real results. Use after any code change and before saying that something works.
---

Run every check and report facts. Fix nothing in this command.

1. Read the Commands section of `CLAUDE.md` and the `scripts` of `package.json`.
2. Run, in this order, each script that exists: `typecheck`, `lint`, `test:unit`, `test:integration`, `test:concurrency`. Run all of them even if one fails.
3. For each one report: the command, the exit code, the duration, passed and failed counts, and the first failing test with its error message.
4. Confirm with a search that every integration and concurrency test file asserts the ledger invariant. List the files that do not.
5. Finish with one line: `ALL GREEN` or `FAILING: <which>`.

- A script that does not exist yet is reported as "not implemented yet", not as passing.
- A suite that did not run is reported as not run.
- Never summarise a failure as a success, and never report a result that was not produced by a command in this turn.
