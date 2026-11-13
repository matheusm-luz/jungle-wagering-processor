# Progress

The assistant has no reliable clock. Matheus states the current time; this file is recalculated then.

## Clock

| Item | Value |
| --- | --- |
| Statement received | 2026-11-12 10:32 |
| Deadline | **2026-11-15 10:32** |
| Last time informed | 2026-11-13 15:33 |
| Budget stated on 12 Nov | 6h from 20:51, so the night session ends at about 02:50 on 13 Nov; 3.6h of it are used |
| Daily budget | 10h |

**Remaining budget (at 13 Nov 15:33):** S0 to S5 are done and merged (S5 is #5). Work left: S6–S13 **13.5h** plus about **0.5h** of double-entry (settlement postings of S6 reuse the S4 path; the trial balance of S8), so **14h**. Hours left depend on how much of the 10h of 13 Nov is already spent, which Matheus did not state: (a) working until midnight, 8.4h today + 10h on 14 Nov = **18.4h**, slack **4.4h**; (b) if S1–S5 took their planned 7.5h, of which 2.4h fell in the night session, about 5h of 13 Nov are spent: 5h + 10h = **15h**, slack **1h**. The morning of 15 Nov is not part of the budget: Matheus allows it only for a critical emergency.

## Next step

S6 is done (13 Nov), committed on the branch `feat/s6-reversals`. Next is S7, pending references (worker, backoff, exhaustion, `WagerTransactionPendingReference`).

1. S6 reaches `main` through a pull request, as S1 to S5 did. Then `/sdd-implement S7` from an up-to-date `main`. The workflow commands are listed in `CLAUDE.md`.
2. With no slack, the first overrun triggers the cut order of `PLAN.md`: optional items (already out), then the pt-BR translations, then the CI workflow.

## Phases

| Phase | Deliverable | Status |
| --- | --- | --- |
| 0 | Reading, summary, first matrix, gaps, decisions, plan (in chat) | done |
| 1 | [spec/REQUIREMENTS.md](spec/REQUIREMENTS.md) | approved 13 Nov |
| 2 | [ARCHITECTURE.md](../ARCHITECTURE.md) | approved 13 Nov |
| 3 | [PLAN.md](PLAN.md) | approved 13 Nov |
| 4 | Implementation, slice by slice | S0 to S6 done; next is S7 |

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
- **`reject` does not record the resolved reference id.** Decided in S6: it stays that way. A rejected row keeps the declared external id only, because the resolved one may belong to another wallet and the same-wallet foreign key would refuse it.
- **`Wallet.debit` throws one error, `InsufficientFundsError`.** The use case maps it to `INSUFFICIENT_FUNDS` (S4) or, for a `ROLLBACK`, `REVERSAL_WOULD_OVERDRAW` (S6).
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

## Findings from S3 that later slices depend on

- **Decisions of 13 Nov (docs/tasks/S3.md).** The outbox starts in S3: `IntegrationEvent`, `WagerTransactionProcessed` and `WalletBalanceChanged` exist in `src/domain/events/`; a positive opening emits both, a zero opening emits nothing. The `OPENING` row is `providerId = 'SYSTEM'`, `externalTransactionId = idempotencyKey = 'opening:<walletId>'`, `roundId = gameId = 'OPENING'`, hashed with the canonical hash. `WagerTransactionProcessed.data` carries the transaction identity, `kind`, `money`, the reference when present, the observed `balance` and `walletVersion`. S4 adds `WagerTransactionRejected`, S7 `WagerTransactionPendingReference`.
- **Every event's `aggregateId` is the wallet id,** also for transaction events: the wallet is the unit of ordering and the future `MessageGroupId` (ADR-11). `causationId` is absent over HTTP; S9 sets it to the SQS `messageId`.
- **The canonical hash exists** (`src/application/payload-hash.ts`): a flat object with keys `amount`, `currency`, `externalTransactionId`, `gameId`, `kind`, `playerId`, `providerId`, `roundId`, `walletId` and, when declared, `referenceExternalTransactionId`. S4 only adds the transport-field tests.
- **Ports and transaction boundary.** `UnitOfWork.run(work)` (`src/application/ports.ts`) forks an `EntityManager` and runs `em.transactional()`. Every write in `TransactionScope` is a native `em.insert` (`insertMany` for the outbox), sent before it returns, with no identity map or flush; the records have no ORM relations, so the call order is the foreign-key order (wallet, transaction, entry, outbox). The wallet update of S4 is the first write that needs a tracked entity (loaded under the lock). S4 extends the scope with the wallet lock (`findOne` with `LockMode.PESSIMISTIC_WRITE`), the lookups and the wallet update.
- **Constraint names reach the application.** `UniqueConstraintViolationException` carries `constraint`, because MikroORM's `DriverException` copies every property of the `pg` error (checked in `@mikro-orm/core/exceptions.js` and proven by `unit-of-work.test.ts`). The map lives in `mikro-orm-unit-of-work.ts`; S4 adds the idempotency and external-id constraints there.
- **System accounts are resolved by one select in the common case;** only a missing account costs `INSERT … ON CONFLICT DO NOTHING` and a second select. The settlement account of S4 uses the same path.
- **Application layer has no NestJS import.** Use cases are plain classes built by factory providers in `AppModule`; ports are bound to symbols in `src/application/tokens.ts`.
- **HTTP errors are `{ code, message }`** through `ErrorFilter`, which handles `ApplicationError`, `RequestValidationError` and malformed JSON, and leaves every other exception to Nest (health keeps its body; an unexpected error is a plain 500, still to become 503 where transient in S12). Validation messages carry field paths only, never values.
- **Request schema.** `playerId` is 1 to 128 characters, with no format (it is `text` in the schema) and no U+0000, which PostgreSQL cannot store in `text` (a driver error and a 500 otherwise); unknown fields are refused at every level. S4 must apply the same rules to every provider identifier, and refuse `providerId = 'SYSTEM'` with 400 before the constraint below turns it into a 500.
- **`SYSTEM` is reserved in the schema.** `Migration20261113010000_system_provider` adds `CHECK ((provider_id = 'SYSTEM') = (kind = 'OPENING'))`. It is validated against existing rows, so `wagering_test` was dropped and recreated on 13 Nov (it held `OPENING` rows of other providers written by S2 tests); `wagering` had no violating row. Test fixtures default an `OPENING` row to `SYSTEM`.
- **Test order within S3.** T1 to T6 were test-first and each test was seen failing for the expected reason. In T7 the `GET` route was written with the controller of T6, before its tests; a mutation run (UUID validation removed) made "an id that is not a UUID is 400" fail with a 500, so the test is not vacuous.
- **Independent review (13 Nov).** The `invariant-reviewer` found no blocker. Fixed at Matheus's request: M1 (`SYSTEM` reserved in the schema), M2 (concurrent first use and rollback of the `FUNDING` account, both proven by a mutation run that resolves the account outside the transaction: the rollback test fails), m1 (U+0000 in `playerId`), m5 (`PROGRESS.md` and `REQUIREMENTS.md` had been rewritten with CRLF; `.gitattributes` now forces LF for every text file). Recorded for later slices:
  - **m2, for S12:** an unexpected driver error reaches Nest's `BaseExceptionFilter`, which logs `exception.message`; MikroORM appends the PostgreSQL detail to it, and a `CHECK` violation's detail is the failing row (player, amounts). `ErrorFilter` must log only `code`, `constraint` and `sqlState` for a `DriverException` when S12 turns transient errors into 503.
  - **m3, for S7:** `toWagerTransactionRecord` writes `referenceAttempts = 0` and `nextAttemptAt = null`, and `transactions.insert` carries no schedule. A `PENDING_REFERENCE` insert through it violates `wager_transactions_next_attempt_when_pending`; S7 must pass `nextAttemptAt` through the port.
  - **m4:** the 409 of a duplicate wallet carries no wallet id; L-19, proposed in REQUIREMENTS.
- **Not done:** the ADR-12 sentence on the `FOR KEY SHARE` lock (S2 review, m6) is still open.

## Findings from S4 that later slices depend on

- **Decisions of 13 Nov (docs/tasks/S4.md).** Q1: a credit beyond `NUMERIC(19,2)` is `REJECTED` with `BALANCE_LIMIT_EXCEEDED` (422, event), added by `Migration20261113020000_balance_limit`. Q2: `WagerTransactionRejected.data` is the data of `WagerTransactionProcessed` plus `failureCode`. Q3: storing `correlationId` (L-15) is deferred to S7.
- **One use case, `ProcessWagerTransaction`** (`src/application/process-wager-transaction.ts`), for HTTP now and SQS in S9: S9 passes `data.idempotencyKey` as `idempotencyKey` and must add `causationId` to the command. Rules the domain refuses at creation become `InvalidWagerTransactionError` (`VALIDATION_ERROR`, 400), which S9 treats as permanent (DLQ).
- **Order inside the transaction:** lock → `WalletNotFoundError` → lookup by key or provider + external id (same key and hash: replay; other hash: `IDEMPOTENCY_KEY_CONFLICT`; other key: `EXTERNAL_TRANSACTION_CONFLICT`) → player, then currency → movement → writes. A replay is answered before the player and currency checks, from the stored row. A key resent with an unknown wallet is 404, not 409.
- **Scope additions:** `wallets.lock` (`findOne` with `PESSIMISTIC_WRITE`, no identity map), `wallets.update(wallet, expectedVersion)` (native `UPDATE … WHERE id AND version`, throws on a miss), `transactions.findByIdentity`. Every read skips the identity map and every write is native: nothing is flushed at commit. The two transaction unique constraints map straight to 409 by name; ARCHITECTURE §2 now says so.
- **References opened in S6.** The request schema accepts the five submittable kinds and `referenceExternalTransactionId`; S6 resolves the reference under the same wallet lock (same-wallet foreign key).
- **`FAILED` has no HTTP status yet.** `WageringController` throws (500) for a status outside 200/202/422 (`shortcut:` comment); S12 decides, with `lock_timeout` and `statement_timeout` (still unset) and the 503.
- **HTTP validation lives in `src/infrastructure/http/validation.ts`,** shared by both controllers: identifiers 1 to 128 characters without U+0000, `Idempotency-Key` 1 to 256 visible ASCII characters (`idempotencyKeySchema`, for S9 to reuse on `data.idempotencyKey`), `walletId` a UUID, `providerId` `SYSTEM` refused.
- **Times.** `createdAt` is the arrival; the movement, `processed_at`, `wallet.updated_at`, the entry and the events take the clock read after the lock, so within one wallet they follow the version. Clocks of different instances can still disagree; consumers order by `walletVersion` (L-14).
- **Independent review (13 Nov).** The `invariant-reviewer` found no blocker and no major. Fixed at Matheus's request: m1 (clock after the lock), m2 (key format), m3 (L-20: no `balance` in the HTTP answer to `WALLET_PLAYER_MISMATCH`; the row and the event keep it), m4 (cross-wallet test and its matrix citation), m5 (lock test waits on `pg_stat_activity`, no sleep), m7 (branch, matrix rows R-26, R-28, R-38, R-62). Recorded, not fixed: m6 (player = wallet owner is a use-case rule, not a schema guarantee; ARCHITECTURE §9). Its caveat stands: R-39 and R-47 are proven in one process; S5 proves them across three.
- **Test order within S4.** T2, T3, T4, T5, T6 and the replay cases of T7 were test-first and seen failing for the expected reason. Not seen failing: the two 409 cases of T7 (the unique-index backstop already answered 409 before the lookup existed) and T8 (the schema was written with the controller in T5); a mutation run (the `SYSTEM` refusal removed) made T8 fail with a 500, so it is not vacuous. T9 passes by construction of the unit of work. A mutation run without `PESSIMISTIC_WRITE` made the lock test fail.
- **Not done:** concurrency across processes is S5; the in-process tests only prove the lock with two transactions and the backstop with two wallets.

## Slices

Status: `todo`, `doing`, `done`. Details and tests in [PLAN.md](PLAN.md).

| # | Slice | Planned day | Hours | Status |
| --- | --- | --- | --- | --- |
| — | Environment, repository move, risk tests, private GitHub repository | 12 Nov | — | done |
| — | Requirements, architecture, plan and workflow commands | 12–13 Nov | — | done, approved 13 Nov |
| S0 | Scaffold and harness | 12 Nov | 1.5 | done 13 Nov |
| S1 | Domain core | 13 Nov, night session | 1.5 | done 13 Nov |
| S2 | Schema and migrations | 13 Nov | 1.5 | done 13 Nov |
| S3 | Open and read a wallet | 13 Nov | 1.0 | done 13 Nov |
| S4 | `BET`, `WIN`, `LOSS` over HTTP | 13 Nov | 2.0 | done 13 Nov |
| S5 | Multi-process harness and first concurrency tests | 13 Nov | 1.0 | done 13 Nov |
| S6 | Reversals | 13 Nov | 1.5 | done 13 Nov |
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

- Repository: `C:\Projetos\JungleGaming\backend-challenge`, remote `origin` = private GitHub repository `jungle-wagering-processor`. `main` was pushed on 13 Nov, up to the S0 scaffold and the budget recalculation; later commits stay local until Matheus asks for a push. S1 was merged into `main` through pull request #1 on 13 Nov. S2 was merged into `main` through pull request #2 on 13 Nov. S3 was merged into `main` through pull request #3 on 13 Nov. S4 lives on the branch `feat/s4-bet-win-loss`.
- Bun 1.4.4, installed through npm. `D:\Programas\nvm\installs\v24.21.0` was added to the user PATH on 12 Nov; terminals opened before that need a restart.
- Docker Desktop 29.9.3 with Compose v5.7.0. An already-open VS Code does not see the Docker CLI; restart VS Code. Docker Desktop was not running when S1 was verified: check that it is up before `test:integration`.
- Images already pulled: `localstack/localstack:4.12`, `postgres:17-alpine`.

## Findings from S5 that later slices depend on

- **Harness (ADR-09).** `startProcesses(count)` in `test/support/processes.ts` spawns `bun src/main.ts` with the suite environment and a free port each, waits for `/health/ready` and stops them with `SIGTERM`. It returns `urls`, `pids` and `stop()`; S9 and S10 need to kill one chosen process and inject a failpoint, so they will extend it (a per-process `kill(i, signal)` and extra environment per process). Process logs are off (`LOG_LEVEL=silent` of the test container) and stderr is read only when a process dies before it is ready. Two latent risks for S9 (review m6): `stop()` has no deadline and no `SIGKILL` fallback, which a consumer in a 20 s long poll could push past the 30 s `afterAll`; and stderr is a pipe nobody drains while the process lives, so a process that writes about 64 KB to it would block. S9 adds the deadline and inherits or drains stderr. The harness refuses duplicate probe ports (review m2).
- **`bun run test:concurrency`** runs `test/concurrency/` in the same `test` image and container as the integration suite. The concurrency suite takes about 2 s.
- **The `version` guard is a real second line.** In the mutation run without `PESSIMISTIC_WRITE`, every race test failed but the ledger invariant held: the version guard of `wallets.update` and `UNIQUE (wallet_id, sequence)` refused the lost updates. Those refusals are not mapped (a plain 500, or 409 when the idempotency index fires first); with the lock in place they cannot happen.
- **No `lock_timeout` yet, and the wait is bounded by the pool, not by the lock (review m4).** A request waits for the wallet lock while holding a pool connection; the `pg` pool has `max` 10 per process (`mikro-orm.config.ts` sets no `pool`), and `connectionTimeoutMillis` (5000) is also the wait for a free connection. On a hot wallet held for more than 5 s, the requests beyond 10 per process fail with `timeout exceeded when trying to connect`, a 500 today. Nothing is written and a retry with the same key is idempotent. S12 sets `lock_timeout` and `statement_timeout`, maps both those and the pool acquisition timeout to 503, and tests the three.
- **Not covered here:** reversals racing their reference (S7; reversals racing each other are S6), the SQS consumer and outbox publisher across processes (S9, S10), restart (R-71).
- **Independent review (13 Nov).** The `invariant-reviewer` found no blocker and no major. Fixed at Matheus's request: m1 (money compared as strings in tests, never `number`), m2 (duplicate probe ports refused), m3 (R-47 across processes: same key, two payloads, one 200 and one 409), m5 (the R-66 wait is tied to the runner's backend through `pg_blocking_pids`). Recorded: m4 (pool wait, for S12) and m6 (harness stop and stderr, for S9), above. The S4 caveat is closed: R-39 and R-47 are now proven across three processes. Mutation runs (global advisory lock, hash check off, failing `afterAll`) are listed in `docs/tasks/S5.md`.

## Findings from S6 that later slices depend on

- **Decisions of 13 Nov (docs/tasks/S6.md).** Q1: a missing reference, or one that is itself `PENDING_REFERENCE` (L-10), is persisted `PENDING_REFERENCE` with `next_attempt_at = created_at` and answered 202 with the observed balance. Q2 (L-09): `WIN` and `LOSS` may reference a `PROCESSED` `BET` of the same player, wallet, currency and round; no amount check, and a reversed `BET` can still be referenced (ARCHITECTURE §9).
- **Rules live in the domain.** `WagerTransaction.referenceFailure(reference, alreadyReversed)` returns the first broken rule in the order ownership → kind → status → amount → single reversal; the last two bind only `REFUND` and `ROLLBACK`. A `PENDING_REFERENCE` reference breaks no rule: the use case then waits.
- **Order inside the transaction:** S4's order, then, after the player and currency checks, `transactions.findByExternalId(providerId, reference)` (any wallet) and, for a reversal, `transactions.hasProcessedReversal(referenceId)` (the predicate of `wager_transactions_single_reversal`). Both reads are after the wallet lock, so two reversals of one `BET` are serialised and the second sees the first. The index is a backstop the lock makes unreachable; if it ever fires it is a 500, not an answer.
- **For S7.** A `PENDING_REFERENCE` row is only ever inserted; S7 owns the attempts and the backoff (`shortcut:` in `toWagerTransactionRecord`) and the `WagerTransactionPendingReference` event (`shortcut:` in `ProcessWagerTransaction`: a waiting row emits no event yet). The worker must call the same reference resolution under the wallet lock and then `markProcessed(reference.id, …)` or `reject`.
- **Independent review (13 Nov).** The `invariant-reviewer` found no blocker and no major. Fixed at Matheus's request: m1 (L-09 and ARCHITECTURE §9 now say that a `BET` settled by a `WIN` can still be reversed and that several `WIN`s may reference one `BET`), m2 (second `ROLLBACK` of a `WIN` and of a `REFUND` over HTTP), m3 (R-42 back to `in progress`, R-40 to `in progress`, R-35 cites the lookup test), m4 (the branch is created before the commit). Caveat for S7: the worker must lock the wallet before it re-evaluates `referenceFailure` and `hasProcessedReversal`, or single reversal rests on the index alone.
- **Test order within S6.** T1 to T7 were test-first and seen failing for the expected reason (missing method, missing scope reads, `wager_transactions_next_attempt_when_pending`, 400 from the closed schema). T8 passed on the first run, as the task predicted: the wallet lock already serialises the races. Three cases of the S4 400 list (`REFUND`, `ROLLBACK` and `WIN` with a reference) became valid by design and were replaced by the L-18 cases that stay 400 (reference missing, `BET` with one, self reference, empty, too long, not a string).
