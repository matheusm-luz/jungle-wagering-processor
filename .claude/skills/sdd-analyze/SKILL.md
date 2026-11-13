---
description: SDD consistency audit (analyze). Read-only cross-check of statement, requirements matrix, ADRs, plan, migrations, code and tests, reporting gaps and contradictions by severity.
argument-hint: "[optional scope, e.g. S4 or idempotency]"
disable-model-invocation: true
---

Audit the repository for consistency. Scope: $ARGUMENTS (whole repository when empty). Change nothing.

Check, in this order:

1. **Statement → matrix.** Re-read statement sections 5, 7, 9, 10, 11, 13 and 14. List anything that no `R-xx` row traces.
2. **Matrix → plan.** Every `R-xx` appears in at least one slice of `docs/PLAN.md`, and every requirement a slice lists exists.
3. **Matrix → tests.** Every row marked `done` names a test that exists and passes. Every mandatory test (`MT`) maps to a test file.
4. **Disqualifying failures.** Each of E-1 to E-8 has its guard in the code or schema and a test that would fail without it.
5. **Schema guarantees.** Each row of `ARCHITECTURE.md` §3 exists in a migration and has a constraint test.
6. **ADRs → code.** Locking order, hash field list, status mapping, failure codes, retry values and event topology match what the ADRs say.
7. **Red flags in code.** Search for: money typed as `number`, `parseFloat`, `Number(` or `toFixed` outside `Money`; an in-memory `Map` or `Set` used for deduplication; a publish or an ack before a commit; `.only` or `.skip` in tests; mocks of PostgreSQL or SQS in integration or concurrency tests; `sleep`-based assertions; `TODO` and `FIXME`.

Report in Portuguese as a table: finding, severity (`blocker`, `major`, `minor`), evidence with `file:line`, smallest fix. Blockers first. Say plainly when a check found nothing, and never invent a finding to fill the table.
