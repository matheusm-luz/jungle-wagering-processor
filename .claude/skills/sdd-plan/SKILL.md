---
description: SDD step 2 (plan). Turn a design question into an ADR in ARCHITECTURE.md, or change the scope and order of slices in docs/PLAN.md, always with options first.
argument-hint: <design question, ADR number or slice id>
disable-model-invocation: true
---

Design step for: $ARGUMENTS

1. Read `ARCHITECTURE.md`, `docs/spec/REQUIREMENTS.md`, `docs/PLAN.md` and the budget in `docs/PROGRESS.md`.
2. **If this is a design decision:**
   - Present two or three options with one trade-off each and a recommendation. Stop and wait for Matheus to choose.
   - After he chooses, write or update the ADR in `ARCHITECTURE.md` as context → options → decision → consequences.
   - When an existing ADR changes, edit that ADR and say what changed and why. Never leave two ADRs that contradict each other.
3. **If this changes scope or order:**
   - Update the slice table in `docs/PLAN.md`: requirements covered, tests that prove the slice, hours.
   - Recompute the schedule against the remaining budget. If it no longer fits, say what is cut, following the cut order in `docs/PLAN.md`.
4. Check that every requirement touched is still covered by a slice.

This command never edits code or tests.
