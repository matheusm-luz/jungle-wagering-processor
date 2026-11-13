---
description: SDD step 3 (tasks). Break one slice of docs/PLAN.md into a short ordered checklist in docs/tasks/, tests before code, so the slice can be reviewed first and resumed in another session.
argument-hint: <slice id, e.g. S3>
disable-model-invocation: true
---

Break slice $ARGUMENTS into tasks.

1. Read the slice row in `docs/PLAN.md`, every requirement it lists in `docs/spec/REQUIREMENTS.md`, the ADRs it depends on in `ARCHITECTURE.md`, and the task files of earlier slices in `docs/tasks/` so names stay consistent.
2. Write `docs/tasks/<slice>.md` with exactly these parts:
   - **Goal:** one sentence.
   - **Tasks:** 5 to 12 checklist items, `- [ ] T1 …`, in execution order. Each item states what is built, the test that proves it (file and case name) and the files created or changed. The test task comes before the code it proves. Each task can be verified on its own.
   - **Subtle points:** which of transaction boundary, lock, idempotency, ack and outbox this slice touches, and where.
   - **Open questions:** anything the statement or the ADRs do not answer. Leave the section out when there is none.
3. Check coverage: every requirement of the slice maps to at least one task and one test. List any that does not.
4. Show the checklist to Matheus in the chat. If there are open questions, stop and ask them before any implementation.

This command never edits code or tests.
