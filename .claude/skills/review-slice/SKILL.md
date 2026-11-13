---
description: Independent review before a commit. Runs the invariant-reviewer subagent on the uncommitted changes and relays its findings.
argument-hint: "[optional focus, e.g. locking]"
disable-model-invocation: true
---

Run an independent review of the current slice. Focus, if any: $ARGUMENTS

1. Launch the `invariant-reviewer` subagent. Give it the slice id, the focus above and nothing about how the code was written: it must judge the diff cold.
2. Relay its findings to Matheus in Portuguese, most severe first, with `file:line`.
3. For each finding say whether you agree, and why. Do not hide one you disagree with.
4. Change nothing until Matheus says which findings to fix.
