# Progress

The assistant has no reliable clock. Matheus states the current time; this file is recalculated then.

## Clock

| Item | Value |
| --- | --- |
| Statement received | 2026-11-12 10:32 |
| Deadline | **2026-11-15 10:32** |
| Last time informed | 2026-11-13 00:28 |
| Budget stated on 12 Nov | 6h from 20:51, so the night session ends at about 02:50 on 13 Nov; 3.6h of it are used |
| Daily budget | 10h |

**Remaining budget (at 13 Nov 00:28):** 2.4h left of the night session, 10h on 13 Nov, 10h on 14 Nov: **22.4h**. The slices that are not done need **22h** (S1–S13 20.5h, double-entry 1.5h; see [PLAN.md](PLAN.md)). Slack: **0.4h**, which is none in practice — the 2.5h buffer went into the specification phase and S0. This assumes the night session still runs to about 02:50 as stated; if the hours after midnight count against the 10h of 13 Nov, the budget is 20h and the deficit is 2h. The morning of 15 Nov is not part of the budget: Matheus allows it only for a critical emergency.

## Next step

S2 is done (13 Nov), on the branch `feat/s2-schema`. Next is S3, open and read a wallet.

1. S2 reaches `main` through a pull request, as S1 did (merged on 13 Nov). Merge it, update the local `main`, then `/sdd-implement S3`. The workflow commands are listed in `CLAUDE.md`.
2. Matheus decided L-16, L-17 and L-18 on 13 Nov, and where the counterparty rule of ADR-12 lives (see the findings from S1).
3. With no slack, the first overrun triggers the cut order of `PLAN.md`: optional items (already out), then the pt-BR translations, then the CI workflow.

## Phases

| Phase | Deliverable | Status |
| --- | --- | --- |
| 0 | Reading, summary, first matrix, gaps, decisions, plan (in chat) | done |
| 1 | [spec/REQUIREMENTS.md](spec/REQUIREMENTS.md) | approved 13 Nov |
| 2 | [ARCHITECTURE.md](../ARCHITECTURE.md) | approved 13 Nov |
| 3 | [PLAN.md](PLAN.md) | approved 13 Nov |
| 4 | Implementation, slice by slice | S0, S1 and S2 done; next is S3 |

## Decisions confirmed by Matheus (12 Nov, unless dated)

Full reasoning in [ARCHITECTURE.md](../ARCHITECTURE.md).

| # | Topic | Decision |
| --- | --- | --- |
| D1 | Concurrency | Pessimistic `SELECT … FOR UPDATE` on the wallet row; `CHECK (balance >= 0)` and a unique per-wallet ledger sequence as defence in depth |
| D2 | Money | `NUMERIC(19,2)` + `CHAR(3)`; `decimal.js` with an isolated high-precision instance |
| D3 | Idempotency | The transaction row is the idempotency record. SHA-256 over hand-written canonical JSON, closed field list, unknown fields rejected |
| D4 | Outbox worker | Polling with `FOR UPDATE SKIP LOCKED`, batches of 10, short client timeout |
| D5 | Retries | Pending references: backoff 1s × 2ⁿ, cap 60s, 10 attempts. SQS consumer: visibility backoff, 5 receives before the DLQ |
| D6 | HTTP status | Derived from the persisted state: 200, 202, 400, 404, 409, 422, 503 with `Retry-After` |
| D7 | Emulator | LocalStack community pinned at `4.12`; MiniStack as fallback |
| D8 | Authentication | Extension point only; Keycloak design documented |
| D9 | Three instances in tests | Three real app processes spawned by the test, inside a Linux container |
| D10 | Domain × ORM | Pure domain, separate persistence records, mappers calling `rehydrate` |
| D11 | Event destination | SNS FIFO topic with SQS FIFO subscriptions |
| D12 | Double-entry | In scope, as a differential. Transfer-row model: each ledger entry names a counterparty system account (`FUNDING` or `PROVIDER_SETTLEMENT`), with no materialised system balance and no extra lock |
| L-01 | Reversal uniqueness | One processed reversal per reference, of any kind |
| L-02 | Amount format | Exactly two decimals |
| L-06 | `PENDING` (13 Nov) | Never committed; the schema refuses it |
| L-03 | Zero amounts | Positive for `BET`, `WIN`, `REFUND`, `ROLLBACK`; zero allowed for `LOSS` and opening balance |
| L-08 | Unknown wallet | Not persisted: 404 over HTTP; ack with log, metric and inbox row on SQS |
| L-16 | Currencies (13 Nov) | Any ISO-4217 code by shape, no allow-list; scale of two for all; the challenge runs in `BRL` |
| L-17 | Amount spelling (13 Nov) | No sign, no whitespace, no leading zeros, at most 17 integer digits |
| L-18 | Reference by kind (13 Nov) | Required for `REFUND` and `ROLLBACK`, accepted for `WIN` and `LOSS`, refused for `BET` and `OPENING`; no self-reference |

Other answers: latest majors of the stack; repository documents in English, with `README.pt-BR.md` and `ARCHITECTURE.pt-BR.md` generated once at the freeze; Biome; delivery through the form (repository link, application e-mail, optional notes).

## Risk tests (12 Nov, throwaway code outside the repository)

**Stack — passed.** Bun 1.4.4, NestJS 12.5.0, MikroORM 7.2.9, `@mikro-orm/nestjs` 7.1.0, TypeScript 7.0.2, decimal.js 10.6.0, PostgreSQL 17.

- NestJS boots under Bun with constructor injection; `tsc --noEmit` is clean on TypeScript 7 with `experimentalDecorators` and `emitDecoratorMetadata`.
- MikroORM entity declared with `defineEntity` (no decorators); `NUMERIC(19,2)` comes back as a string.
- Migrations run programmatically (`orm.migrator.up()` and `.down()`) from a static `migrationsList`.
- Miniature of the mandatory race over HTTP: balance 100, two concurrent debits of 80 → one 200, one 422, final balance `"20.00"`, version 2.
- `CHECK (balance >= 0)` is rejected by PostgreSQL (SQLSTATE 23514). `FOR UPDATE SKIP LOCKED` skips a locked row in 2 ms.
- Type the ORM from the driver package (`MikroORM` and `EntityManager` from `@mikro-orm/postgresql`); the core type has no `execute`.

**Emulator — passed.** `localstack/localstack:4.12` (4.12.0, community, built 2025-12-11, 1.86 GB) starts without a token.

- SQS FIFO: deduplication by `MessageDeduplicationId`, `ApproximateReceiveCount`, long polling, `ChangeMessageVisibility` with zero and positive timeouts, native redrive to a FIFO DLQ after `maxReceiveCount`.
- SNS FIFO topic → SQS FIFO subscription with raw delivery: duplicate publish deduplicated, group id and message attributes preserved, `PublishBatch` of 10 keeps the order inside each group.
- Not root-caused: in the first, badly isolated run, one message did not return after a positive visibility backoff. It did not reproduce in the isolated run (four cycles, FIFO and standard).

Findings that affect the design:

- One `ReceiveMessage` batch can contain several messages of the same group. The consumer must process a group in order and stop at its first failure.
- An unacknowledged message blocks its whole group, so a poison message must leave for the DLQ quickly.
- Visibility expiry in LocalStack has a granularity of about 1s. Tests must not assert sub-second retry timing.
- NestJS documents `SIGTERM` as never working on Windows. Shutdown tests run in Linux containers.

Setup that was verified and can be reused in S0 (the throwaway code itself was not kept):

- `tsconfig`: `module: Preserve`, `moduleResolution: bundler`, `strict`, `experimentalDecorators`, `emitDecoratorMetadata`, `types: ["bun"]`, `noEmit`.
- Entry point imports `reflect-metadata` first, then `NestFactory.create(AppModule)` on `@nestjs/platform-express` and `app.enableShutdownHooks()`.
- MikroORM config: `defineConfig` from `@mikro-orm/postgresql` with `clientUrl`, an explicit `entities` list (no globs), `extensions: [Migrator]` and `migrations: { migrationsList: [{ name, class }], snapshot: false }`; wired with `MikroOrmModule.forRoot(config)`.
- Record: `defineEntity({ name, tableName, properties: { id: p.uuid().primary(), balance: p.type(DecimalType).columnType('numeric(19,2)'), version: p.integer() } })`.
- Lock: `em.findOne(Record, id, { lockMode: LockMode.PESSIMISTIC_WRITE })` inside `em.transactional()`. In MikroORM 7 a changed record needs an explicit `em.persist(record)`. Raw SQL: `em.execute(sql, [params])` with `?` placeholders.
- LocalStack container: `SERVICES=sqs,sns`, health at `/_localstack/health`, region `us-east-1`, dummy credentials `test` / `test`.
- Ids: `Bun.randomUUIDv7()`.

## Findings from S0 that later slices depend on

- **MikroORM 7 connects lazily.** `orm.checkConnection()` answers "Connection not established" until some query has run, even with PostgreSQL up. Readiness uses `orm.em.getConnection().execute('select 1')`, which connects on first use.
- **The `pg` driver has no connect timeout by default.** A server that accepts the connection and never answers hangs the caller and `orm.close()`. `DATABASE_CONNECT_TIMEOUT_MS` (default 5000) is passed as `driverOptions.connectionTimeoutMillis`. Statement and lock timeouts are still open, for S4 and S12.
- **LocalStack returns queue URLs on `sqs.us-east-1.localhost.localstack.cloud:4566`,** a name that resolves to 127.0.0.1 and is therefore wrong inside another container. S0 only resolves the queue by name, so nothing breaks yet. S9 must decide how the consumer addresses the queue and check it in the official LocalStack and AWS SDK documentation.
- **MikroORM's `debug` option must stay off:** query logging prints SQL parameters, which are financial data. The ORM's own lines (migrator progress) already go through the JSON logger.
- **Biome's `useImportType` is off** on purpose: it rewrites the imports of classes that NestJS injects by type into `import type`, which erases them at run time.
- **Migrations never run at application boot.** `migrate` is a one-shot Compose service; test suites that need the schema call `runMigrations` in their setup.
- **Suites use the database `wagering_test`,** created by `infra/postgres/init` when the volume is first initialised. A volume created before that script existed has to be recreated.
- **Ledger-invariant helper.** Delivered in S2: `test/support/ledger-invariant.ts`. Every integration file, the S0 ones included, now ends with it.
- **Requirements with no slice in `PLAN.md`:** R-51 (the no-op `AuthGuard` and `ProviderIdentityPort` of ADR-08 need code, and the health endpoints must stay outside the guard) and the cross-cutting R-04 to R-07, R-10 to R-12, R-62 and R-69. To be assigned through `/sdd-plan`.

## Findings from S1 that later slices depend on

- **The domain takes ids and time from the caller.** `Wallet.open`, `debit` and `credit` receive the entry id, the transaction id and `at`, so the domain has no port. The id generator and the clock are application ports, due in S3.
- **`Wallet.open` returns `{ wallet, openingEntry }`.** The entry is `undefined` for a zero balance. S3 creates and persists the `OPENING` transaction only when the entry exists, and must choose the provider id, external id and idempotency key of that internal transaction.
- **A ledger entry carries `sequence`,** the wallet version it produced. S2 needs the column and `UNIQUE (wallet_id, sequence)`.
- **A transaction carries `observedBalance`** (ADR-03), set by `markProcessed`, `markPendingReference` and `reject`; `fail` leaves it as it was. Its currency is the wallet's, which differs from the transaction's own currency on a `CURRENCY_MISMATCH` rejection. S2 has to store it so that it rehydrates exactly.
- **`reject` does not record the resolved reference id.** S6 decides whether a rejection found by the reference rules should keep it for audit.
- **`Wallet.debit` throws one error, `InsufficientFundsError`.** The use case maps it to `INSUFFICIENT_FUNDS` (S4) or `REVERSAL_WOULD_OVERDRAW` (S6).
- **`Wallet.credit` can throw `MoneyOutOfRangeError`** when the new balance would exceed `NUMERIC(19,2)`. It is reachable with valid input (two maximum credits) and is deliberately not an `InvalidMoneyError`, so it cannot be answered as a 400 that depends on the balance. ARCHITECTURE §6 has no code for it: S4 must decide the outcome, through `/sdd-plan`.
- **A wallet opened with a zero balance has its first entry at `sequence` 2,** because it is already at version 1. The ledger cursor of S8 must not assume that sequences start at 1.
- **`reject` refuses `PROCESSING_FAILED` and `fail` accepts only it.** `ledgerDirectionFor` refuses a transaction that is not the declared reference (same provider, declared external id).
- **The domain checks few strings.** `WagerTransaction.create` refuses an empty `idempotencyKey`, `providerId` or `externalTransactionId`, and a self-reference. Length, charset and the other identifiers are the job of the request schema in S4.
- **Mappers of S3 must convert `NULL` to `undefined`.** Every optional check in the domain is `=== undefined`; a `null` would count as a declared reference. Typed mappers without casts make the compiler catch it. `version` and `sequence` are `number` in the domain, so their columns are `INTEGER`, not `BIGINT` (which the driver returns as a string).
- **`Money.from` refuses a negative amount and a malformed currency code,** and it is also the rehydration path. Balances are safe (`CHECK (balance >= 0)`); the reconciliation difference of S8 must come from `subtract`, never from `Money.from`. The same holds for the trial balance of ADR-12: the net of a `PROVIDER_SETTLEMENT` account is bets minus wins and can be negative, so SQL returns the debit and credit sums separately (both non-negative) and the domain subtracts. A sum can also exceed 17 integer digits, which `Money.from` refuses. S2 may mirror the currency shape in a `CHECK (currency ~ '^[A-Z]{3}$')`.
- **`Money.equals` across currencies is `false`, not an error;** `add`, `subtract` and `isLessThan` throw `CurrencyMismatchError`.
- **Domain errors carry no failure code and no HTTP status.** The mapping to 400, 422 and the rest belongs to S3 and S4. The transport-level codes of ARCHITECTURE §6 (`VALIDATION_ERROR`, `WALLET_NOT_FOUND` and the others that are never persisted) are not in the domain `FailureCode`.
- **Counterparty of ADR-12 (decided by Matheus, 13 Nov).** The rule "`OPENING` posts against `FUNDING`; `BET`, `WIN`, `REFUND` and `ROLLBACK` post against the settlement account of the provider" will be a domain query on `WagerTransaction`, unit-tested, added in S3 with its first use. The repository resolves it to `counterparty_account_id`; `WalletMovement` and `LedgerEntryState` stay as they are. Rejected: the account id on the ledger entry; the rule only in the persistence mapper.
- **Integration events are not built yet,** although ARCHITECTURE §1 places them in the domain. They arrive with S4, as planned.

## Findings from S2 that later slices depend on

- **Every constraint and index has a name, and Bun reports it.** `Bun.SQL` errors carry the SQLSTATE in `errno` and the name in `constraint`. S3 and S4 map by name: `wallets_player_currency_key` → 409 `WALLET_ALREADY_EXISTS`; `wager_transactions_idempotency_key_key` and `wager_transactions_provider_external_key` → roll back, re-read and answer (the backstop path of ARCHITECTURE §2); `wager_transactions_single_reversal` → the S6 race. MikroORM wraps driver errors, so S3 must check which property carries the name there (`UniqueConstraintViolationException` and its cause) in the official docs.
- **Trigger refusals are SQLSTATE `P0001`.** They mean a programming error (an update of a terminal row, a ledger change), never a business outcome: the application must not map them to 409 or 422.
- **Internal ids are `uuid` columns.** A `walletId` that is not a UUID makes PostgreSQL raise `22P02` instead of returning no row, so the request schema of S4 must validate it as a UUID before the query, or the provider gets a 500 instead of a 400 or 404. Provider-supplied strings (`playerId`, external ids, round, game, idempotency key) are `text` with no format.
- **The `OPENING` transaction of S3 must satisfy the same constraints as any other:** `payload_hash` of 64 lowercase hex characters, a non-empty `provider_id` and external id unique per provider, `PROCESSED` with `processed_at` and the observed balance. S3 chooses those values.
- **`FUNDING` accounts are created on first use, like settlement accounts.** L-16 admits any currency, so the migration seeds nothing. Both go through `INSERT … ON CONFLICT DO NOTHING` and a select (proven in `schema-ledger-accounts.test.ts`).
- **Columns the domain does not model yet:** `reference_attempts` and `next_attempt_at` on `wager_transactions` (S7); `outbox_messages.next_attempt_at` is `NOT NULL` and starts at `occurred_at`, so `OutboxMessage.enqueue` or its mapper sets it (S10). `correlation_id` is not stored: L-15 is still proposed, and S4 adds it with its own migration if accepted.
- **The schema refuses `PENDING`** (L-06, accepted 13 Nov). A `PENDING_REFERENCE` row must have `next_attempt_at` and no `reference_transaction_id`; it may only move to a terminal status, and `FAILED` keeps its observed balance (trigger). S7 sets `next_attempt_at` when it persists the row.
- **A reference must belong to the same wallet** (composite foreign key, rule 7.2). A rejected reversal may keep its resolved reference id only when it is in the same wallet: a `REFERENCE_MISMATCH` against another wallet leaves `reference_transaction_id` null. The single-reversal index counts only `PROCESSED` rows, so a rejected reversal can sit next to the applied one.
- **The ledger-invariant helper checks more than the balance:** version against the last sequence, the chain of entries (balance and sequence), exactly one entry of the right amount, currency and direction for each processed transaction that moves money, and no entry for the others. A test that commits a processed transaction must commit its entry and the wallet change with it (`applyTransaction` in `test/support/schema-fixtures.ts`, the SQL shape of the S4 use case).
- **Tests cannot clean the ledger,** by design. Every test uses fresh ids and the invariant runs over the whole suite database. `schema.test.ts` runs its down/up cycle on a throwaway database of its own, `wagering_schema_lifecycle`. A state that must never be committed is written inside `inRolledBackTransaction`. Changing a migration that was already applied requires recreating `wagering` and `wagering_test` (done on 13 Nov).
- **Independent review (13 Nov).** The `invariant-reviewer` found no blocker. Fixed at Matheus's request: M1 (helper and fixtures), M2 (same-wallet reference), M3 (pending row always due), m1 (`PENDING`), m2 (pending transitions), m3 (truncate test proves its own trigger), m4 (one refusal test per constraint), m7 (own database for the down/up cycle), m8 (order-independent tests). Not done: m5 (entry-to-transaction amount and status in the schema; the helper covers it in tests), m6 (the foreign key to `ledger_accounts` takes a `FOR KEY SHARE` lock on a shared account row: it serialises nothing, but ADR-12's "no shared row is written" is not literally true; worth a sentence in ADR-12 or §9), m9 (`inbox_messages.processed_at` kept because statement §6.5 defines it).
- **Test order within S2 was not test-first after T2.** The migration was written whole in T2; the tests of T3–T8 came after it. Each refusal asserts the exact constraint name and each file has a positive control, so none passes by accident, but none was seen failing first.

## Slices

Status: `todo`, `doing`, `done`. Details and tests in [PLAN.md](PLAN.md).

| # | Slice | Planned day | Hours | Status |
| --- | --- | --- | --- | --- |
| — | Environment, repository move, risk tests, private GitHub repository | 12 Nov | — | done |
| — | Requirements, architecture, plan and workflow commands | 12–13 Nov | — | done, approved 13 Nov |
| S0 | Scaffold and harness | 12 Nov | 1.5 | done 13 Nov |
| S1 | Domain core | 13 Nov, night session | 1.5 | done 13 Nov |
| S2 | Schema and migrations | 13 Nov | 1.5 | done 13 Nov |
| S3 | Open and read a wallet | 13 Nov | 1.0 | todo |
| S4 | `BET`, `WIN`, `LOSS` over HTTP | 13 Nov | 2.0 | todo |
| S5 | Multi-process harness and first concurrency tests | 13 Nov | 1.0 | todo |
| S6 | Reversals | 13 Nov | 1.5 | todo |
| S7 | Pending references | 13 Nov | 1.5 | todo |
| S8 | Read side | 13 Nov | 1.0 | todo |
| S9 | SQS consumer | 14 Nov | 2.5 | todo |
| S10 | Outbox publisher | 14 Nov | 2.0 | todo |
| S11 | Observability and CI | 14 Nov | 1.0 | todo |
| S12 | Failure modes | 14 Nov | 1.0 | todo |
| S13 | Documentation and delivery | 14 Nov | 3.0 | todo |
| — | Double-entry, folded into S2, S3, S4, S6, S8 | 13 Nov | +1.5 | todo |

- **Freeze:** end of the 8th hour on 14 Nov. Submit that night.
- **Optional, only if ahead:** load test, Keycloak, OpenTelemetry.

## Environment

- Repository: `C:\Projetos\JungleGaming\backend-challenge`, remote `origin` = private GitHub repository `jungle-wagering-processor`. `main` was pushed on 13 Nov, up to the S0 scaffold and the budget recalculation; later commits stay local until Matheus asks for a push. S1 was merged into `main` through pull request #1 on 13 Nov. S2 lives on the branch `feat/s2-schema`, local only until Matheus asks for a push.
- Bun 1.4.4, installed through npm. `D:\Programas\nvm\installs\v24.21.0` was added to the user PATH on 12 Nov; terminals opened before that need a restart.
- Docker Desktop 29.9.3 with Compose v5.7.0. An already-open VS Code does not see the Docker CLI; restart VS Code. Docker Desktop was not running when S1 was verified: check that it is up before `test:integration`.
- Images already pulled: `localstack/localstack:4.12`, `postgres:17-alpine`.
