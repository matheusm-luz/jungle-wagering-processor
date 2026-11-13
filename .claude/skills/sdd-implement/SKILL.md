---
description: SDD step 4 (implement). Implement one slice of docs/PLAN.md test-first, run every check, meet the definition of done, commit once and report the subtle parts.
argument-hint: <slice id, e.g. S3>
disable-model-invocation: true
---

Implement slice $ARGUMENTS.

## Before writing code

1. Read `CLAUDE.md` and `docs/PROGRESS.md`.
2. Stop and ask Matheus if any of these is true:
   - the specification documents are still untracked in `git status` (not approved yet);
   - an earlier slice is not `done` in `docs/PROGRESS.md`;
   - `docs/tasks/<slice>.md` has open questions.
3. If `docs/tasks/<slice>.md` does not exist, create it exactly as `/sdd-tasks` does, show it, and continue.

## For each unchecked task, in order

1. Write the test first and run it. It must fail for the reason the task describes.
2. Write the minimum code that makes it pass, then run it again.
3. Tick the task in `docs/tasks/<slice>.md`.

Rules that never bend:

- Never weaken, skip or delete a test to make a run pass.
- Integration and concurrency tests use the real PostgreSQL and LocalStack containers and real parallelism.
- Every integration and concurrency test ends by asserting the ledger invariant.
- When the code disagrees with an ADR, stop: either the code is wrong or the ADR must change through `/sdd-plan`.
- New MikroORM, NestJS, Bun or AWS behaviour is checked in the official documentation, not guessed.

## After the last task

1. Run every check, as `/verify` does, and paste the real output. A failure is fixed or reported, never described as success.
2. Meet the definition of done in `CLAUDE.md`: requirement statuses in the matrix (`done` only with the name of a passing test), ADR if a decision changed, `docs/PROGRESS.md`, and the Commands section of `CLAUDE.md` if scripts changed.
3. For a slice that touches money, locking, idempotency, messaging or the schema, offer `/review-slice` before committing. It costs a subagent run, so Matheus decides.
4. Commit once: Conventional Commits, staged file by file, authored by Matheus, no AI attribution. Push only if Matheus asked for pushes.

## Report, in Portuguese

- What was done and why, in a few lines.
- The subtle parts, each with `file:line`: transaction boundary, lock, idempotency, ack, outbox.
- What was left out or is weaker than planned.
- The next slice.

Then stop. Do not start the next slice.
