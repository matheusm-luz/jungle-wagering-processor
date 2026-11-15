# Implementation plan

**Status:** approved by Matheus on 13 Nov 2026. Slices are vertical: each one ends with tests green, typecheck and lint clean, the matrix updated and one atomic commit. Requirement ids refer to [spec/REQUIREMENTS.md](spec/REQUIREMENTS.md); decisions refer to [ARCHITECTURE.md](../ARCHITECTURE.md).

## Slices

| # | Slice | Requirements | Tests that prove it | Hours |
| --- | --- | --- | --- | --- |
| S0 | **Scaffold and harness.** Package scripts, strict tsconfig, Biome, Dockerfile, Compose (PostgreSQL, LocalStack with an init script for queues, topic and subscription, app, test runner), env validation, JSON logger with correlation id, programmatic migration runner, `/health/live` and `/health/ready` | R-01, R-02, R-03, R-50, R-60 | Health integration test: ready is 200 with both dependencies up; all check scripts run clean | 1.5 |
| S1 | **Domain core.** `Money`, `Wallet`, `WagerTransaction` with its state machine, `WalletLedgerEntry`, failure codes, domain errors | R-15–R-28 | Unit: `Money` scale and invalid inputs, currency conflict, wallet invariants, terminal-state transitions, ledger arithmetic | 1.5 |
| S2 | **Schema and migrations.** All tables, constraints, indexes and triggers from ARCHITECTURE §3 | R-03, R-09, R-13, R-20, R-21 | Integration: `up` then `down` leaves an empty schema; one test per constraint (negative balance, duplicate wallet, duplicate key, duplicate external id, second reversal, ledger `UPDATE`/`DELETE`/`TRUNCATE`, broken arithmetic) | 1.5 |
| S3 | **Open and read a wallet.** `POST /wallets` with `OPENING`, `CREDIT` and outbox in one transaction; `GET /wallets/:id` | R-22, R-24, R-43, R-44 | Integration: opening creates wallet, transaction and entry atomically; zero balance creates no entry; duplicate → 409; ledger invariant | 1.0 |
| S4 | **Process `BET`, `WIN`, `LOSS` over HTTP.** Use case, canonical hash, replay and conflict, wallet lock, outbox rows, event classes, status mapping | R-29–R-32, R-39, R-46–R-48, R-58, R-59 | Unit: hash is stable and ignores transport fields; divergent payload. Integration: replay returns the original balance; 409 on conflict; 422 on insufficient funds; `OPENING` refused; forced rollback leaves no row and no event | 2.0 |
| S5 | **Multi-process harness and first concurrency tests.** Test helper that spawns three app processes and asserts the ledger invariant | R-64–R-67, R-72 | Concurrency: same bet 50 times → one debit; 100 with two bets of 80 → one `PROCESSED`, one `REJECTED`, balance 20, one debit; distinct wallets in parallel; three processes | 1.0 |
| S6 | **Reversals.** `REFUND` and `ROLLBACK`: reference resolution, ownership, kind, amount, single reversal, overdraw | R-33–R-38, R-41, R-42 | Unit: every rule and its failure code. Integration: refund then rollback of the same bet → `REFERENCE_ALREADY_REVERSED`; rollback of a spent win → `REVERSAL_WOULD_OVERDRAW`; concurrent double refund → one applied | 1.5 |
| S7 | **Pending references.** 202 with `PENDING_REFERENCE`, scheduled worker with backoff, exhaustion | R-40, R-70 | Concurrency: reversal delivered before its reference is applied once the reference arrives. Integration: exhaustion → `REJECTED` + event; two workers never apply twice | 1.5 |
| S8 | **Read side.** Transaction by id and by provider + external id, ledger cursor, reconciliation | R-44, R-45, R-49 | Integration: cursor walks all entries once under concurrent writes; a balance tampered through SQL is reported as inconsistent, logged and counted, and not fixed | 1.0 |
| S9 | **SQS consumer.** Inbox, same use case, ack after commit, error classes, visibility backoff, DLQ, `SIGTERM` | R-52–R-56, R-68 | Integration: redelivery has no second effect; transient failure reaches the DLQ after the limit; poison message goes straight to the DLQ. Concurrency: process killed after commit and before ack → no duplicate; `SIGTERM` returns visibility | 2.5 |
| S10 | **Outbox publisher.** `SKIP LOCKED` batches to the SNS FIFO topic, retry with backoff | R-08, R-57, R-71 | Concurrency: two publishers publish every event without loss; process killed after commit and before publish → another instance publishes; restart ends consistent. Integration: a duplicated publication carries the same `eventId` | 2.0 |
| S11 | **Observability and CI.** `/metrics` with the seven required metrics, log audit for payload leaks, GitHub Actions workflow running the same checks | R-60, R-61 | Integration: each metric moves when its event happens; a log-capture test finds no amount fields | 1.0 |
| S12 | **Failure modes.** PostgreSQL down → 503 and not ready; SQS down → consumer and publisher back off and recover; `FAILED` path | R-14, R-63 | Integration: cut and restore each dependency through a TCP proxy in front of the real container (docs/tasks/S12.md Q1, instead of stopping it), then assert no lost event and the ledger invariant | 1.0 |
| S13 | **Documentation and delivery.** Solution `README.md`, statement moved to `docs/CHALLENGE.md`, final `ARCHITECTURE.md`, pt-BR translations, matrix review against statement §14, clean-clone validation | R-73–R-75 | A fresh clone goes from zero to all suites green following only the README | 3.0 |

**Double-entry (ADR-12)** is folded into the slices it touches rather than added at the end, because retrofitting a ledger schema costs more than building it once: `ledger_accounts` and the counterparty column in S2, postings against `FUNDING` in S3 and against the provider account in S4 and S6, the trial-balance check in S8. Extra cost with the accepted transfer-row model: about 1.5h.

**Optional, only when ahead of plan, in this order:** load test (`bun run test:load`, 1.5–2h), Keycloak (3–5h), OpenTelemetry (2h or more).

## Schedule

Core slices add up to 22h; with double-entry (transfer-row model) 23.5h. Budget: 6h on 12 Nov, 10h on 13 Nov, 10h on 14 Nov.

| Day | Slices | Hours |
| --- | --- | --- |
| 12 Nov | Approvals, S0, S1, S2 | 5.5 |
| 13 Nov | S3, S4, S5, S6, S7, S8, start of S9 | 10 |
| 14 Nov | Rest of S9, S10, S11, S12, S13, buffer | 10 |

- **Freeze:** end of the 8th hour on 14 Nov. Submit that night. The morning of 15 Nov is not part of the plan; Matheus allows it only for a critical emergency.
- **Never cut:** S5 and the other concurrency tests, the matrix review, the clean-clone validation.
- **Cut order if behind:** optional items first, then the pt-BR translations, then the CI workflow.

## Slice-level choices already settled by the risk tests

- HTTP adapter: `@nestjs/platform-express`.
- Request validation: schema-based, rejecting unknown keys, in front of the domain `Money` validation.
- Migrations: programmatic, from a static list.
- Integration and concurrency suites always run inside the Linux test container, so they behave the same on Windows, macOS, Linux and CI.

## How slices are executed

Each slice had a task checklist in `docs/tasks/` and one commit through a pull request. The checks of the README (`typecheck`, `lint`, `test:unit`, `test:integration`, `test:concurrency`) ran after every change, an independent review was done on the risky slices (S4, S6, S7, S9, S10), and an independent audit of the whole repository was done on 14 Nov, after S13 (the "audit" rows of `docs/PROGRESS.md`).

The assistant's working agreement and command files that drove this workflow were removed from the repository at the freeze (14 Nov); the documents they wrote to (`ARCHITECTURE.md`, this plan, the matrix, `docs/PROGRESS.md`, `docs/tasks/`) stay.
