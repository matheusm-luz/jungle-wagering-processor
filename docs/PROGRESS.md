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

S0 is done (13 Nov, 00:26). Next is S1, the domain core.

1. `/sdd-implement S1` in what is left of the night session (1.5h, no Docker needed), then S2. The workflow commands are listed in `CLAUDE.md`.
2. With no slack, the first overrun triggers the cut order of `PLAN.md`: optional items (already out), then the pt-BR translations, then the CI workflow.

## Phases

| Phase | Deliverable | Status |
| --- | --- | --- |
| 0 | Reading, summary, first matrix, gaps, decisions, plan (in chat) | done |
| 1 | [spec/REQUIREMENTS.md](spec/REQUIREMENTS.md) | approved 13 Nov |
| 2 | [ARCHITECTURE.md](../ARCHITECTURE.md) | approved 13 Nov |
| 3 | [PLAN.md](PLAN.md) | approved 13 Nov |
| 4 | Implementation, slice by slice | S0 done; next is S1 |

## Decisions confirmed by Matheus (12 Nov)

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
| L-03 | Zero amounts | Positive for `BET`, `WIN`, `REFUND`, `ROLLBACK`; zero allowed for `LOSS` and opening balance |
| L-08 | Unknown wallet | Not persisted: 404 over HTTP; ack with log, metric and inbox row on SQS |

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
- **Ledger-invariant helper.** No S0 test can assert the ledger invariant, because the tables arrive in S2. The shared helper is due with the first test that writes a wallet (S3).
- **Requirements with no slice in `PLAN.md`:** R-51 (the no-op `AuthGuard` and `ProviderIdentityPort` of ADR-08 need code, and the health endpoints must stay outside the guard) and the cross-cutting R-04 to R-07, R-10 to R-12, R-62 and R-69. To be assigned through `/sdd-plan`.

## Slices

Status: `todo`, `doing`, `done`. Details and tests in [PLAN.md](PLAN.md).

| # | Slice | Planned day | Hours | Status |
| --- | --- | --- | --- | --- |
| — | Environment, repository move, risk tests, private GitHub repository | 12 Nov | — | done |
| — | Requirements, architecture, plan and workflow commands | 12–13 Nov | — | done, approved 13 Nov |
| S0 | Scaffold and harness | 12 Nov | 1.5 | done 13 Nov |
| S1 | Domain core | 13 Nov, night session | 1.5 | todo |
| S2 | Schema and migrations | 13 Nov | 1.5 | todo |
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

- Repository: `C:\Projetos\JungleGaming\backend-challenge`, remote `origin` = private GitHub repository `jungle-wagering-processor`. `main` was pushed on 13 Nov, up to the S0 scaffold and the budget recalculation; later commits stay local until Matheus asks for a push.
- Bun 1.4.4, installed through npm. `D:\Programas\nvm\installs\v24.21.0` was added to the user PATH on 12 Nov; terminals opened before that need a restart.
- Docker Desktop 29.9.3 with Compose v5.7.0. An already-open VS Code does not see the Docker CLI; restart VS Code.
- Images already pulled: `localstack/localstack:4.12`, `postgres:17-alpine`.
