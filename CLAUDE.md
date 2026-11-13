# Distributed Wagering Processor — working agreement

## Goal

Take-home challenge for a Senior Backend position at Jungle Gaming: a distributed financial service that processes wagering transactions (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) from several providers, over HTTP and SQS. It is graded on financial correctness, concurrency across instances, persistent idempotency, balance/ledger consistency, inbox/outbox messaging, failure recovery and clarity of decisions — not on CRUD.

- The statement is the source of truth: `README.md` today, `docs/CHALLENGE.md` once the solution README exists. Never edit its content.
- Requirements and open interpretations: [docs/spec/REQUIREMENTS.md](docs/spec/REQUIREMENTS.md).
- Time budget, confirmed decisions and current status: [docs/PROGRESS.md](docs/PROGRESS.md). Read it first in every session. The deadline is 2026-11-15 10:32.

## How we work

1. Spec-driven, with Matheus's approval between phases: requirements → `ARCHITECTURE.md` (short ADRs) → `docs/PLAN.md` (vertical slices) → implementation.
2. For every important decision, present two or three options with trade-offs and wait for his choice. He defends the solution in a technical interview.
3. When the statement is ambiguous, do not invent: record the question and a proposed interpretation in REQUIREMENTS.md.
4. After each slice, explain in a few lines what was done and why, and point to the subtle parts: transaction boundary, lock, idempotency, ack, outbox.
5. Never say something works without having run it. Run the checks after every change and show the output.
6. Use only the statement and official documentation (NestJS, MikroORM, PostgreSQL, AWS SQS/SNS, LocalStack, Bun). Never consult or copy other candidates' solutions.
7. Prefer simplicity. No layer or abstraction that does not protect an invariant or a boundary.
8. Reply to Matheus in Portuguese. Code, identifiers, commits and repository documents are in English. `README.pt-BR.md` and `ARCHITECTURE.pt-BR.md` are generated once, at the freeze.
9. There is no reliable clock. When Matheus states the current time, recalculate the budget in `docs/PROGRESS.md` and say what still fits.
10. Work one slice of `docs/PLAN.md` at a time, in order. Do not start the next slice before reporting the current one.

## Workflow commands

Project skills in `.claude/skills/`. They follow the spec-kit sequence but write to the documents this repository already has, so there is one source of truth per phase.

| Command | Phase | Writes to |
| --- | --- | --- |
| `/sdd-spec <text>` | Specify and clarify | `docs/spec/REQUIREMENTS.md` |
| `/sdd-plan <question or slice>` | Plan | `ARCHITECTURE.md`, `docs/PLAN.md` |
| `/sdd-tasks <slice>` | Tasks | `docs/tasks/<slice>.md` |
| `/sdd-implement <slice>` | Implement, test-first, one commit | code, tests, matrix, `docs/PROGRESS.md` |
| `/sdd-analyze [scope]` | Consistency audit, read-only | nothing |
| `/verify` | Run every check and report real results | nothing |
| `/progress <time>` | Recalculate the time budget | `docs/PROGRESS.md` |
| `/review-slice [focus]` | Independent review by the `invariant-reviewer` subagent | nothing |
| `/defend <slice or topic>` | Explanation, likely interview questions, quiz | nothing |

- The spec-kit "constitution" is this file: invariants, conventions and definition of done.
- The phase commands are manual only. `/verify` and `/progress` may also be used by the assistant on its own.
- `/review-slice` starts a subagent, which is the expensive path. Use it on slices that touch money, locking, idempotency, messaging or the schema.

## Commands

Planned; none exists until the scaffold slice. Update this section when they do.

| Command | Purpose |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit`, strict |
| `bun run lint` | Biome |
| `bun run test:unit` | Domain tests, no I/O |
| `bun run test:integration` | Real PostgreSQL and LocalStack through Docker Compose |
| `bun run test:concurrency` | Real parallelism, three or more app processes |
| `bun run test:load` | Optional load test |

## Global invariants

Treat each one as a test that must exist. Breaking any of the first eight disqualifies the submission.

1. Money is never a `number`. `Money` is an immutable value object, serialised as a decimal string with two places.
2. Idempotency is persisted in PostgreSQL. A replay returns the original result; the same key with a different payload is a conflict.
3. Correct with three or more instances. The unit of concurrency is `walletId`; no global lock; never `read → calculate → update` without control.
4. Balance is never negative, and no debit or credit is applied twice.
5. Uniqueness, immutability and non-negativity are enforced in the schema (constraints, indexes, triggers), not only in code.
6. Wallet, ledger, transaction, inbox and outbox change in the same SQL transaction. No event is published before commit. SQS ack happens only after commit.
7. The ledger is append-only. Final invariant of every test: `wallet.balance == balance rebuilt from the ledger`.
8. Integration and concurrency tests use real PostgreSQL and SQS containers, never mocks of them.
9. The domain layer imports nothing from the ORM or from NestJS.

## Conventions

- Stack: Bun 1.x, TypeScript strict, NestJS, MikroORM, PostgreSQL, SQS and SNS through LocalStack `4.12`, Docker Compose. No Prisma.
- Domain classes: private constructor, static factories (`create`, `from`, `rehydrate`); `rehydrate` never re-validates transitions.
- Migrations are hand-written SQL, versioned and reversible (`up` and `down`).
- Logs are JSON with `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, and never contain full financial payloads.
- Commits follow Conventional Commits, authored only by Matheus, with no AI attribution of any kind.

## Definition of done for a slice

- Tests green; typecheck and lint clean.
- Requirements matrix updated.
- ADR updated if a decision changed.
- `docs/PROGRESS.md` updated.
- One atomic commit with a clear message.
