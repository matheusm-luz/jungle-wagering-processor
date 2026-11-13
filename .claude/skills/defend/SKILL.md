---
description: Interview preparation. Explain one slice or topic so Matheus can defend it, list the hardest questions an interviewer would ask, then quiz him.
argument-hint: <slice id or topic, e.g. S4 or "outbox">
disable-model-invocation: true
---

Prepare Matheus to defend: $ARGUMENTS

Everything happens in the chat, in Portuguese. Create no file.

1. **Explain** the design in at most ten lines, with `file:line` for every subtle part: transaction boundary, lock, idempotency, ack, outbox.
2. **Hard questions.** Give the five questions a senior interviewer is most likely to ask about it: failure modes, the rejected alternatives, limits under load. Answer each in two or three lines and cite the ADR.
3. **Honest weakness.** Name one real limitation and a truthful way to present it.
4. **Quiz.** Ask him three questions, one at a time. After each answer, say what was right, what was missing, and where in the code the answer lives.

Explain MikroORM concepts (Unit of Work, identity map, `em.fork()`, `em.transactional()`, `LockMode`) when they appear; he has not used it in production. SQS concepts need no introduction.
