---
description: Recalculate the time budget in docs/PROGRESS.md. Use whenever Matheus states the current time or the hours he still has.
argument-hint: <current time, e.g. "13/11 09:10", and hours available if known>
---

Matheus says: $ARGUMENTS

1. Update the Clock table in `docs/PROGRESS.md` with the time he stated.
2. Update slice statuses from `git log` and from `docs/tasks/`.
3. Compute the hours left until the deadline, at most 10h per day, never counting the morning of 15 Nov.
4. Sum the hours of the slices that are not `done` in `docs/PLAN.md`.
5. Compare the two and update the "Remaining budget" line.

Reply in Portuguese, in at most eight lines: hours left, work left, slack or deficit, and a recommendation. On a deficit, propose cuts in the cut order of `docs/PLAN.md`. Never propose cutting the concurrency tests, the matrix review or the clean-clone validation.
