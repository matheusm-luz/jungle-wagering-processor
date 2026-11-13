---
description: SDD step 1 (specify and clarify). Record or refine a requirement or an interpretation in the traceability matrix, without inventing answers the statement does not give.
argument-hint: <requirement, doubt or statement section>
disable-model-invocation: true
---

Update the specification for: $ARGUMENTS

1. Re-read the relevant part of the statement (`docs/CHALLENGE.md`, or `README.md` while the statement still lives there). The statement wins over every other document.
2. Classify the input:
   - **A requirement the matrix misses or states wrongly.** Add or fix a row in `docs/spec/REQUIREMENTS.md`: next free `R-xx`, source section, type, status `pending`.
   - **An ambiguity or a gap.** Add an `L-xx` row with the question and status `open`. Do not choose an interpretation yourself.
3. For an open interpretation, give Matheus two or three options, one trade-off each, and a recommendation. Then stop and wait for his answer.
4. When he decides, mark the row `accepted`, keep the rejected alternative in the same row, and copy the accepted text to section 7 of `ARCHITECTURE.md`.
5. If the change affects a slice, name the slice and say what must change in `docs/PLAN.md`.

This command never edits code or tests.
