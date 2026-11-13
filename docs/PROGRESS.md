# Progress

The assistant has no reliable clock. Matheus states the current time; this file is recalculated then.

## Clock

| Item | Value |
| --- | --- |
| Statement received | 2026-11-12 10:32 |
| Deadline | **2026-11-15 10:32** |
| Last time informed | 2026-11-12 20:51, with 1h spent |
| Budget stated afterwards | 6 more hours on 12 Nov |
| Daily budget | 10h |

**Remaining budget:** 6h on 12 Nov, 10h on 13 Nov, 10h on 14 Nov: **26h**. The plan needs 23.5h (see [PLAN.md](PLAN.md)), which leaves about 2.5h. The morning of 15 Nov is not part of the budget: Matheus allows it only for a critical emergency.

## Next step

Requirements, architecture and plan were approved by Matheus on 13 Nov and are committed.

1. Run `/progress <current time>` first: the schedule below still assumes S0–S2 on 12 Nov, and none of them started that day.
2. Start implementation with `/sdd-implement S0`, then S1 and S2. The workflow commands are listed in `CLAUDE.md`.

## Phases

| Phase | Deliverable | Status |
| --- | --- | --- |
| 0 | Reading, summary, first matrix, gaps, decisions, plan (in chat) | done |
| 1 | [spec/REQUIREMENTS.md](spec/REQUIREMENTS.md) | approved 13 Nov |
| 2 | [ARCHITECTURE.md](../ARCHITECTURE.md) | approved 13 Nov |
| 3 | [PLAN.md](PLAN.md) | approved 13 Nov |
| 4 | Implementation, slice by slice | not started; next is S0 |

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

## Slices

Status: `todo`, `doing`, `done`. Details and tests in [PLAN.md](PLAN.md).

| # | Slice | Planned day | Hours | Status |
| --- | --- | --- | --- | --- |
| — | Environment, repository move, risk tests, private GitHub repository | 12 Nov | — | done |
| — | Requirements, architecture, plan and workflow commands | 12–13 Nov | — | done, approved 13 Nov |
| S0 | Scaffold and harness | 12 Nov | 1.5 | todo |
| S1 | Domain core | 12 Nov | 1.5 | todo |
| S2 | Schema and migrations | 12 Nov | 1.5 | todo |
| S3 | Open and read a wallet | 13 Nov | 1.0 | todo |
| S4 | `BET`, `WIN`, `LOSS` over HTTP | 13 Nov | 2.0 | todo |
| S5 | Multi-process harness and first concurrency tests | 13 Nov | 1.0 | todo |
| S6 | Reversals | 13 Nov | 1.5 | todo |
| S7 | Pending references | 13 Nov | 1.5 | todo |
| S8 | Read side | 13 Nov | 1.0 | todo |
| S9 | SQS consumer | 13–14 Nov | 2.5 | todo |
| S10 | Outbox publisher | 14 Nov | 2.0 | todo |
| S11 | Observability and CI | 14 Nov | 1.0 | todo |
| S12 | Failure modes | 14 Nov | 1.0 | todo |
| S13 | Documentation and delivery | 14 Nov | 3.0 | todo |
| — | Double-entry, folded into S2, S3, S4, S6, S8 | 12–13 Nov | +1.5 | todo |

- **Freeze:** end of the 8th hour on 14 Nov. Submit that night.
- **Optional, only if ahead:** load test, Keycloak, OpenTelemetry.

## Environment

- Repository: `C:\Projetos\JungleGaming\backend-challenge`, remote `origin` = private GitHub repository `jungle-wagering-processor`. Only the statement commit is pushed; the specification commits of 13 Nov are local until Matheus asks for a push.
- Bun 1.4.4, installed through npm. `D:\Programas\nvm\installs\v24.21.0` was added to the user PATH on 12 Nov; terminals opened before that need a restart.
- Docker Desktop 29.9.3 with Compose v5.7.0. An already-open VS Code does not see the Docker CLI; restart VS Code.
- Images already pulled: `localstack/localstack:4.12`, `postgres:17-alpine`.
