# Requirements traceability matrix

Source of truth: the challenge statement ([README.md](../../README.md), to be preserved unchanged as `docs/CHALLENGE.md`).
Every requirement below is traced to the section it comes from. A requirement is `done` only when a test or a document proves it.

Requirement types:

| Code | Meaning |
| --- | --- |
| BR | Business rule |
| IC | Inviolable constraint (statement §5 and equivalents) |
| TC | Technical or contract requirement (stack, API, messaging, observability) |
| MT | Mandatory test |
| DOC | Documentation deliverable |
| OPT | Optional differential |

**Status values:** `pending`, `in progress`, `done`, `dropped` (only for OPT).

## 1. Matrix

| ID | § | Type | Requirement | Status |
| --- | --- | --- | --- | --- |
| R-01 | 4 | TC | Bun 1.x as runtime, package manager and test runner; TypeScript strict; NestJS | done — `bun run typecheck` (strict `tsconfig.json`); `test/integration/health.test.ts` "is 200 with PostgreSQL and SQS up" boots NestJS on Bun |
| R-02 | 4 | TC | PostgreSQL; SQS through LocalStack or MiniStack; Docker Compose | done — `compose.yaml`; `test/integration/health.test.ts` "is 200 with PostgreSQL and SQS up" |
| R-03 | 4 | TC | Versioned, reversible migrations | in progress — runner proven by `test/integration/migration-runner.test.ts`; the schema migrations are S2 |
| R-04 | 4 | TC | MikroORM (preferred) or TypeORM; no Prisma | pending |
| R-05 | 5.1 | IC | Money is never a `number`, float or double | pending |
| R-06 | 5.2 | IC | Idempotency is never guaranteed by an in-memory cache | pending |
| R-07 | 5.3, 8 | IC | Broker FIFO and deduplication are an optimisation; the database is the guarantee | pending |
| R-08 | 5.4 | IC | No event is published before the financial transaction commits | pending |
| R-09 | 5.5 | IC | Ledger entries are never overwritten or deleted | pending |
| R-10 | 5.6 | IC | No global lock shared by all wallets | pending |
| R-11 | 5.7 | IC | No `read → calculate → update` without concurrency control | pending |
| R-12 | 5.8, 8 | IC | Correct with three or more application instances | pending |
| R-13 | 5.9 | IC | Uniqueness, immutability and non-negativity enforced in the database schema | pending |
| R-14 | 3 | IC | No duplicated credit or debit, no lost confirmed event, no negative balance | pending |
| R-15 | 6.0 | TC | Private constructors and static factories; `rehydrate` does not re-validate transitions | pending |
| R-16 | 6.1 | BR | `Money` is immutable; decimal string with a fixed scale of 2 | pending |
| R-17 | 6.1 | BR | `Money` rejects NaN, Infinity, scientific notation, empty string, more than 2 decimals, negative input | pending |
| R-18 | 6.1 | BR | Operations across currencies raise a domain error; the model stays multi-currency | pending |
| R-19 | 6.1 | TC | Domain has no ORM types and no NestJS decorators; persistence is exact | pending |
| R-20 | 6.2 | BR | At most one wallet per `playerId` + `currency` | pending |
| R-21 | 6.2 | BR | Balance is never negative | pending |
| R-22 | 6.2 | BR | Every balance change has exactly one ledger entry, and vice versa | pending |
| R-23 | 6.2 | BR | Operation currency equals wallet currency | pending |
| R-24 | 6.2 | BR | `version` starts at 1 and increments only when the balance changes | pending |
| R-25 | 6.3 | BR | Explicit transitions; `PROCESSED`, `REJECTED` and `FAILED` are terminal | pending |
| R-26 | 6.3 | BR | `OPENING` is internal: refused by the API and by the queue | pending |
| R-27 | 6.4 | BR | Ledger entry is structurally immutable; `create` validates the arithmetic | pending |
| R-28 | 6.4 | BR | At most one ledger entry per transaction and wallet; `LOSS` and `REJECTED` create none | pending |
| R-29 | 6.5, 11 | IC | Transaction, balance, ledger, inbox and outbox in the same SQL transaction | pending |
| R-30 | 7 | BR | `BET` debits; rejected when the balance is insufficient | pending |
| R-31 | 7 | BR | `WIN` credits; may reference the `BET` of the same round | pending |
| R-32 | 7 | BR | `LOSS` records the outcome without moving the balance | pending |
| R-33 | 7 | BR | `REFUND` credits; references only a `PROCESSED` `BET`; once | pending |
| R-34 | 7 | BR | `ROLLBACK` inverts a `PROCESSED` `BET`, `WIN` or `REFUND`; once | pending |
| R-35 | 7.1–7.2 | BR | Reversals require a reference, resolved by provider + external id; same provider, player, wallet, currency and round | pending |
| R-36 | 7.4 | BR | A reference is not reversed twice by the same kind of operation (see L-01) | pending |
| R-37 | 7.5 | BR | Reversal amount equals the referenced amount | pending |
| R-38 | 7.6 | BR | `REJECTED` neither changes the balance nor creates a ledger entry | pending |
| R-39 | 7.7 | BR | Replaying a processed operation returns the original result, including the balance observed then | pending |
| R-40 | 7.8, 7.1 | BR | Missing reference → `PENDING_REFERENCE`; scheduled worker with exponential backoff; justified limit; exhausted → `REJECTED` plus event | pending |
| R-41 | 7.9 | BR | A reversal that would make the balance negative is rejected with its own `failureCode` | pending |
| R-42 | 7.2 | BR, DOC | Stable machine-readable `failureCode` on every rejection; taxonomy documented | pending |
| R-43 | 9 | TC | `POST /wallets`: `OPENING` and `CREDIT` in the same SQL transaction; duplicate is a conflict | pending |
| R-44 | 9 | TC | Wallet query; transaction query by id and by provider + external id | pending |
| R-45 | 9 | TC | Ledger pagination with a stable, opaque cursor | pending |
| R-46 | 9 | TC | `POST /wagering/transactions` with a mandatory `Idempotency-Key` header | pending |
| R-47 | 9, 6.3 | BR | `payloadHash` over canonical JSON of the business fields; identical request is a replay, different payload is a conflict | pending |
| R-48 | 9 | TC | HTTP status distinguishes invalid payload, idempotency conflict, business rejection, pending acceptance and transient failure, consistently | pending |
| R-49 | 9 | TC | Reconciliation: divergence is logged, counted in a metric and flagged in the response; never silently fixed | pending |
| R-50 | 9, 12 | TC | `/health/live` and `/health/ready` (PostgreSQL and SQS), without authentication | done — `test/integration/health.test.ts`, seven cases including each dependency down and both hanging |
| R-51 | 2 | DOC, OPT | Authentication: external IdP, or an explicit extension point with the design documented | pending |
| R-52 | 10 | TC | Queues `wager-transactions.fifo` and `wager-transactions-dlq.fifo`; the consumer reuses the HTTP use case | pending |
| R-53 | 10 | IC | Persistent inbox keyed by `(consumerName, messageId)`; redelivery has no duplicated effect | pending |
| R-54 | 10 | IC | Ack only after commit | pending |
| R-55 | 10 | TC | Business error (ack), transient error (retry with backoff), permanent error (DLQ); attempt limit before the DLQ | pending |
| R-56 | 10 | TC | On `SIGTERM`, finish in-flight messages or return their visibility | pending |
| R-57 | 11 | TC | Outbox worker safe with concurrent publishers; survives a crash between commit and publish | pending |
| R-58 | 11 | TC | Four minimum events; `WalletBalanceChanged` only when the balance changes | pending |
| R-59 | 11 | TC | Abstract `IntegrationEvent` envelope with one concrete subclass per event; `data` carries `MoneyProps` | pending |
| R-60 | 12 | TC | JSON logs with `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; no full financial payloads | in progress — logger and correlation id: `test/unit/logging/json-logger.test.ts`, `test/integration/correlation.test.ts`; the payload-leak audit is S11 |
| R-61 | 12 | TC | Metrics: transactions by status, duplicates, retries, DLQ messages, lock conflicts, outbox lag, processing latency | pending |
| R-62 | 13 | MT | Unit: `Money`, `Wallet` invariants, rules of the five operations, currency conflict, divergent payload | pending |
| R-63 | 13 | MT | Integration on real containers: migrations and constraints, atomicity, inbox and redelivery, concurrent publishers, retry and DLQ, restart recovery | pending |
| R-64 | 13 | MT | Same bet sent 50 times in parallel → a single debit | pending |
| R-65 | 13 | MT | Concurrent operations competing for one wallet (balance 100, two bets of 80) | pending |
| R-66 | 13 | MT | Distinct wallets processed in parallel | pending |
| R-67 | 13 | MT | Three or more processes at the same time | pending |
| R-68 | 13 | MT | Worker killed after commit and before ack | pending |
| R-69 | 13 | MT | Two publishers on the same outbox | pending |
| R-70 | 13 | MT | `ROLLBACK` or `REFUND` delivered before its reference | pending |
| R-71 | 13 | MT | Service restart with proof of final consistency | pending |
| R-72 | 13 | MT | Final invariant of every test: `wallet.balance == balance rebuilt from the ledger` | pending |
| R-73 | 14 | DOC | `README.md` with setup and commands; statement preserved as `docs/CHALLENGE.md` | pending |
| R-74 | 4, 8, 14 | DOC | `ARCHITECTURE.md`: ORM, `Money` mapping, transactional and concurrency strategy, trade-offs, limitations | pending |
| R-75 | 6.3, 7 | DOC | Valid transitions, additional interpretations and retry limit documented and justified | pending |
| R-76 | 14 | OPT | `bun run test:load` with methodology, throughput, p50/p95/p99, error rate, conflicts, outbox lag | pending |
| R-77 | 6.4 | OPT | Double-entry ledger, transfer-row model (in scope by Matheus's decision; ADR-12) | pending |
| R-78 | 12 | OPT | OpenTelemetry; dashboard | pending |

## 2. Disqualifying failures (statement §14)

Each one is treated as a test that must exist.

| # | Failure | Guard and proof |
| --- | --- | --- |
| E-1 | `number` for money | `Money` value object, `NUMERIC` in the database, string-only DTOs; contract test on serialisation |
| E-2 | Negative balance caused by a race | Per-wallet lock plus `CHECK (balance >= 0)`; R-65 |
| E-3 | Duplicated debit or credit | Unique indexes (idempotency key, external id, ledger entry, inbox); R-64 and R-68 |
| E-4 | Idempotency only in memory | Replay served by a different instance and after a restart |
| E-5 | Correct only with one instance | R-67 with real processes |
| E-6 | Event published before commit | Outbox row written in the same SQL transaction; test that a rolled-back transaction leaves no event |
| E-7 | No auditable ledger | Append-only ledger with a trigger blocking `UPDATE` and `DELETE`; R-72 |
| E-8 | Tests that replace PostgreSQL and SQS with mocks | Integration and concurrency suites run on real containers |

## 3. Interpretations and gaps

The statement requires every additional interpretation to be documented. `accepted` items were decided by Matheus and are also recorded in `ARCHITECTURE.md`; `proposed` items are the working assumption until he says otherwise.

| # | Question | Proposed interpretation | Status |
| --- | --- | --- | --- |
| L-01 | Rule 7.4 forbids two reversals "by the same kind". Read literally, one `BET` can take a `REFUND` and a `ROLLBACK`: 100 → BET 30 → 70 → REFUND → 100 → ROLLBACK → **130**. | **Accepted (A):** at most one `PROCESSED` reversal per reference, of any kind (partial unique index on `reference_transaction_id`). A `ROLLBACK` of the `REFUND` itself stays allowed. Rejected alternative: unique per reference + kind. | accepted |
| L-02 | Are `"25"` and `"25.5"` valid amounts? | **Accepted (A):** exactly two decimals, no normalisation; anything else is 400. The hash is computed from the normalised `Money`. Rejected alternative: accept and normalise. | accepted |
| L-03 | Is a zero amount accepted? | **Accepted (A):** `BET`, `WIN`, `REFUND`, `ROLLBACK` require a positive amount, otherwise 400; `LOSS` and the opening balance accept zero. Rejected alternative: accept zero as `PROCESSED` without a ledger entry. | accepted |
| L-04 | The header key and the pair provider + external id are two identities. | Both are unique. Same pair under a different key → 409 with its own code. On SQS, `data.idempotencyKey` plays the role of the header and stays out of the hash. | proposed |
| L-05 | What is the "original result" for a transaction that was pending? | The observed balance is stored on the transaction. A replay returns the persisted state, which for a terminal status is the original result. | proposed |
| L-06 | When does `PENDING` exist? | HTTP is synchronous, so `PENDING` is only the initial in-memory state and is never committed. | proposed |
| L-07 | When does a transaction become `FAILED`? | Only when an already persisted transaction hits a non-transient, non-business error. An unreadable message goes to the DLQ without a transaction. | proposed |
| L-08 | Unknown `walletId`: persist the rejection? | **Accepted (A):** not persisted (foreign key): HTTP 404 `WALLET_NOT_FOUND`; on SQS, ack with log, metric and inbox row. Cost: this rejection is not queryable and emits no event. Rejected alternative: persist as `REJECTED` without the foreign key. | accepted |
| L-09 | `WIN` and `LOSS` with or without a reference. | Optional. When present it goes through the same validations. A `WIN` without a reference does not require a `BET` in the round (documented limitation). | proposed |
| L-10 | The reference exists but is not `PROCESSED`. | Terminal reference → reject. Pending reference → keep waiting. | proposed |
| L-11 | The statement does not say where outbox events go. | SNS FIFO topic with an SQS FIFO subscription (decision D11). | proposed |
| L-12 | `MessageGroupId` and `MessageDeduplicationId` are not defined. | Recommended to producers: `walletId` and `messageId`. The consumer does not depend on them. | proposed |
| L-13 | Order of the ledger cursor. | Ascending per-wallet sequence, encoded as base64url. | proposed |
| L-14 | Event ordering with several publishers. | No global order; consumers use `walletVersion` and `eventId`. | proposed |
| L-15 | Origin of `correlationId`. | `X-Correlation-Id` header or generated; stored on the transaction so worker-emitted events keep it. | proposed |
| L-16 | Currencies that do not use two decimals (JPY, KWD). | Out of scope; an allow-list of currencies. | proposed |
