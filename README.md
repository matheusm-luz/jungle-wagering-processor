# Distributed Wagering Processor

A financial service that processes wagering transactions (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) from several providers, over HTTP and over an SQS FIFO queue, and keeps every wallet's balance and its append-only ledger consistent across any number of instances. It is the solution to the Jungle Gaming backend challenge; the statement is preserved unchanged in [docs/CHALLENGE.md](docs/CHALLENGE.md).

Bun, TypeScript (strict), NestJS, MikroORM 7, PostgreSQL 17, SQS and SNS through LocalStack 4.12, Docker Compose.

| Document | What it holds |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The critical section, the schema guarantees, the decisions (ADRs) with their trade-offs, the state machine, the failure codes, the interpretations and the known limitations |
| [docs/spec/REQUIREMENTS.md](docs/spec/REQUIREMENTS.md) | Every requirement of the statement traced to the test that proves it |
| [docs/LOAD-TEST.md](docs/LOAD-TEST.md) | The load experiment: methodology, results and reading |
| [docs/CHALLENGE.md](docs/CHALLENGE.md) | The statement |

Portuguese versions: [README.pt-BR.md](README.pt-BR.md), [ARCHITECTURE.pt-BR.md](ARCHITECTURE.pt-BR.md).

## What is guaranteed, and where it is proven

| Guarantee | Mechanism | Proof |
| --- | --- | --- |
| Money is never a `number` | `Money` value object over `decimal.js`, `NUMERIC(19,2)` columns, amounts as two-decimal strings in every API and event | `test/unit/domain/money.test.ts` |
| One debit for 50 parallel copies of a bet, across three processes | `SELECT … FOR UPDATE` on the wallet row, then the idempotency lookup under the lock; unique indexes as backstop | `test/concurrency/wallet-races.test.ts` |
| Balance never negative | Per-wallet lock, `Wallet.debit()` and `CHECK (balance >= 0)` | same file, 60 bets of 5.00 on a wallet of 100 |
| Idempotency survives restarts and instances | The transaction row is the idempotency record; a replay returns the stored result | `test/integration/wagering-transactions.test.ts` |
| Wallet, ledger, transaction, inbox and outbox commit together; no event before commit; SQS ack after commit | One SQL transaction; outbox publisher with `FOR UPDATE SKIP LOCKED` | `test/integration/unit-of-work.test.ts`, `test/integration/outbox-publisher.test.ts`, `test/concurrency/sqs-consumer.test.ts` (process killed between commit and ack) |
| Ledger is append-only and always explains the balance | Triggers refusing `UPDATE`, `DELETE` and `TRUNCATE`; `UNIQUE (wallet_id, sequence)` | `expectLedgerInvariant` in the `afterAll` of every integration, concurrency and load file |

## Quick start

Prerequisites: Docker with Compose v2, and [Bun](https://bun.sh) 1.x (the scripts, the static checks and the unit tests run on the host; everything else runs in containers).

```bash
git clone <repository-url> wagering && cd wagering
bun install
docker compose up -d --build --wait
```

This starts PostgreSQL, LocalStack (whose init script creates the queues, the DLQ, the SNS FIFO topic and its subscriber queue), a one-shot `migrate` container that applies the migrations, and one application instance. `--wait` returns when every service is healthy.

PostgreSQL and LocalStack are published on the host ports 5432 and 4566. If either is taken (`Bind for 0.0.0.0:5432 failed: port is already allocated`), pick other ports; everything inside Compose, the test suites included, keeps talking to the containers directly (only a host run, `bun run start`, needs the new ports in its `.env`):

```bash
POSTGRES_HOST_PORT=5433 LOCALSTACK_HOST_PORT=4567 docker compose up -d --build --wait
```

The instance publishes its port 3000 on the first free host port between 3000 and 3002. Find it with:

```bash
docker compose port app 3000          # e.g. 0.0.0.0:3000
export API=http://localhost:3000      # use the port printed above
```

Three instances: `docker compose up -d --build --wait --scale app=3`; each gets its own host port from the same range (`docker compose ps`).

Stop everything with `docker compose down`; add `--volumes` to drop the database.

## Walkthrough

Every response below was produced by these commands against the stack. Identifiers will differ.

Open a wallet. The opening balance is an internal `OPENING` transaction, credited from a funding account in the same SQL transaction.

```bash
curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# {"id":"01a1d8d5-1adc-75fe-…","playerId":"player-1","balance":{"amount":"100.00","currency":"BRL"},"version":1}

export WALLET=01a1d8d5-1adc-75fe-…    # the id above
```

Place a bet. `Idempotency-Key` is required; `{providerId}:{externalTransactionId}` is the recommended key.

```bash
BET='{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"player-1","walletId":"'$WALLET'",
      "roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"30.00","currency":"BRL"}}'
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' -d "$BET"
# 200 {"transactionId":"01a1d8d5-1b28-…","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}
```

Send it again: the stored result is replayed, with the balance observed the first time. Send the same key with another amount: conflict.

```bash
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' -d "$BET"
# 200 {"transactionId":"01a1d8d5-1b28-…","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":true}

curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' -d "${BET/30.00/31.00}"
# 409 {"code":"IDEMPOTENCY_KEY_CONFLICT","message":"The idempotency key was already used with another payload"}
```

A `REFUND` that arrives before its `BET` waits (`202 PENDING_REFERENCE`). The pending-reference worker applies it once the `BET` exists (backoff 1 s doubling up to 60 s, 10 attempts, ADR-05). The `BET` does not wake it: the worker finds it on its next attempt, within a second when the `BET` follows at once as below, up to 60 s later otherwise. A `BET` that arrives after the last attempt, about 4 minutes after the `REFUND`, is too late: the `REFUND` ends `REJECTED` with `REFERENCE_NOT_FOUND` (L-10).

```bash
REFUND='{"providerId":"provider-a","externalTransactionId":"refund-2","playerId":"player-1","walletId":"'$WALLET'",
         "roundId":"round-1","gameId":"game-1","kind":"REFUND","money":{"amount":"20.00","currency":"BRL"},
         "referenceExternalTransactionId":"bet-2"}'
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:refund-2' -d "$REFUND"
# 202 {"transactionId":"01a1d8d5-1bbc-…","status":"PENDING_REFERENCE","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}

BET2='{"providerId":"provider-a","externalTransactionId":"bet-2","playerId":"player-1","walletId":"'$WALLET'",
       "roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"20.00","currency":"BRL"}}'
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-2' -d "$BET2"
# 200 {…,"status":"PROCESSED","balance":{"amount":"50.00","currency":"BRL"},…}

curl -s $API/providers/provider-a/wagering/transactions/refund-2     # repeat until it is no longer PENDING_REFERENCE
# {…,"kind":"REFUND","referenceTransactionId":"01a1d8d5-1beb-…","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},…}
```

Read the wallet, its ledger and its reconciliation.

```bash
curl -s $API/wallets/$WALLET
# {"id":"…","playerId":"player-1","balance":{"amount":"70.00","currency":"BRL"},"version":4}

curl -s "$API/wallets/$WALLET/ledger?limit=2"
# {"items":[{…"direction":"CREDIT","money":{"amount":"100.00",…},"sequence":1…},{…"direction":"DEBIT","money":{"amount":"30.00",…},"sequence":2…}],
#  "nextCursor":"MDFhMWQ4…","hasMore":true}
curl -s "$API/wallets/$WALLET/ledger?limit=2&cursor=MDFhMWQ4…"

curl -s -X POST $API/wallets/$WALLET/reconciliation
# {"walletId":"…","storedBalance":{"amount":"70.00",…},"calculatedBalance":{"amount":"70.00",…},
#  "difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":4}
```

The ledger is paged in sequence order with an opaque cursor bound to its wallet (default 50, at most 200 per page). **Stop on `hasMore: false`, not on a missing cursor:** the last page keeps its cursor, so a reader can resume from it after later writes (L-13). Pages are stable under concurrent writes.

A transaction is also readable by id: `GET /wagering/transactions/{transactionId}`.

### Over SQS

The consumer reads `wager-transactions.fifo`. The message is the statement's envelope; `data.idempotencyKey` plays the role of the header, so the same business request sent over HTTP and over SQS is one transaction. Use the wallet id as `MessageGroupId` to keep a wallet's messages in order.

```bash
docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-11-14T12:00:00.000Z",
    "data":{"idempotencyKey":"provider-a:win-1","providerId":"provider-a","externalTransactionId":"win-1",
    "playerId":"player-1","walletId":"'$WALLET'","roundId":"round-1","gameId":"game-1","kind":"WIN",
    "money":{"amount":"15.00","currency":"BRL"}}}'

curl -s $API/wallets/$WALLET      # balance 85.00, version 5
```

On Git Bash for Windows, prefix `docker compose exec` commands with `MSYS_NO_PATHCONV=1`.

Events (`WagerTransactionProcessed`, `WalletBalanceChanged`, `WagerTransactionRejected`, `WagerTransactionPendingReference`) are published after commit to the SNS FIFO topic `wager-events.fifo`, which fans out to the subscriber queue:

```bash
docker compose exec -T localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-events-subscriber.fifo --max-number-of-messages 10
```

Delivery is at least once, ordered per wallet within a publisher batch: a consumer orders by `walletVersion` and deduplicates by `eventId` (L-14).

## For providers: what each answer means

| Answer | Meaning | What to do |
| --- | --- | --- |
| 200 `PROCESSED` | Applied (a `LOSS` is recorded without moving the balance) | Done |
| 202 `PENDING_REFERENCE` | The referenced transaction does not exist yet | Wait for the event, or query the transaction |
| 400 `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED` | Invalid request; nothing stored | Fix the request |
| 403 `PROVIDER_FORBIDDEN` | The caller may not act for this provider (never today: authentication is not implemented, ADR-08) | Use the provider's own credentials |
| 404 `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | Unknown identifier | Fix the identifier |
| 409 `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS` | The key or the external id is already used | Do not resend |
| 422 with a `failureCode` | `REJECTED` by a business rule, or `FAILED` (`PROCESSING_FAILED`) | Read `failureCode`; resending the same key replays the same answer |
| 503 `SERVICE_UNAVAILABLE` with `Retry-After` | Transient failure: lock or statement timeout, pool exhausted, database unreachable | Resend with the **same key**: either nothing was committed, or the resend replays what was |

`POST /wallets` has no idempotency key: a resend after a lost 201 answers 409 `WALLET_ALREADY_EXISTS`, which means the wallet was created. The full failure-code taxonomy is in [ARCHITECTURE.md §6](ARCHITECTURE.md#6-failure-codes-and-http-status).

## Operations

- **Health.** `GET /health/live` (the process answers) and `GET /health/ready` (PostgreSQL and SQS reachable; 503 otherwise). Both are open.
- **Metrics.** `GET /metrics`, Prometheus text format: transactions by channel and status, processing latency, duplicates, retries by source, dead-lettered messages, lock conflicts and lock wait, outbox lag, pending events and their highest attempt count, DLQ depth, reconciliation divergences (ADR-14). Counters are per instance; sum them across instances.
- **Logs.** JSON lines on stdout with `correlationId`, `messageId`, `transactionId`, `walletId` and `providerId`; never amounts or payloads. `X-Correlation-Id` is honoured or generated, returned, and carried into the events.
- **`FAILED` transactions.** Only a waiting transaction whose retries keep failing for a non-business, non-transient reason ends `FAILED` with `PROCESSING_FAILED` (L-07). Nothing moved; it is terminal.
- **Dead-letter queue.** `wager-transactions-dlq.fifo` receives two kinds of message. Those the consumer refused as permanent (unreadable, invalid, conflicting) carry a `failureReason` message attribute; resending them unchanged fails again. Those without it exhausted five receives on transient errors, typically a PostgreSQL outage longer than about 75 s (ARCHITECTURE §9); they are safe to redrive, because the inbox and the idempotency key make a second delivery a no-op if the first one was applied.

  ```bash
  # Inspect, leaving the messages in place
  docker compose exec -T localstack awslocal sqs receive-message --visibility-timeout 0 \
    --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
    --max-number-of-messages 10 --message-attribute-names All

  # Redrive to the source queue (AWS)
  aws sqs start-message-move-task --source-arn arn:aws:sqs:<region>:<account>:wager-transactions-dlq.fifo
  ```

  LocalStack 4.12 fails `start-message-move-task` on FIFO queues (the task ends `FAILED` with `AttributeError`). Locally, resend a message's body to `wager-transactions.fifo` with `send-message` (same group id, a new deduplication id), then delete it from the DLQ.

## Tests

| Command | What runs | Needs Docker |
| --- | --- | --- |
| `bun run typecheck` | `tsc --noEmit`, strict | no |
| `bun run lint` | Biome (`bun run lint:fix` formats) | no |
| `bun run test:unit` | Domain, application and adapters with no I/O | no |
| `bun run test:integration` | Real PostgreSQL and LocalStack: schema constraints and triggers, atomicity, inbox and redelivery, retries and DLQ, concurrent publishers, metrics, log audit, failures of each dependency (through a TCP proxy in front of the real container) | yes |
| `bun run test:concurrency` | Three real `bun src/main.ts` processes: 50 parallel copies of one bet, the two-bets-of-80 race, distinct wallets in parallel, a process killed after commit and before ack, publishers killed mid-batch, reversals before their reference, a process killed under load and replaced | yes |
| `bun run test:load` | Optional load experiment, about two minutes (see [docs/LOAD-TEST.md](docs/LOAD-TEST.md)) | yes |

The Docker suites build a `test` image and run inside it, against the Compose PostgreSQL (a separate `wagering_test` database) and LocalStack, so they behave the same on Linux, macOS, Windows and CI. They start the dependencies themselves; the application container is not needed. Every integration, concurrency and load file ends by checking that each wallet's balance equals the balance rebuilt from its ledger. The same commands, except the load experiment, run on every pull request (`.github/workflows/ci.yml`).

One integration file: `docker compose --profile test run --rm --build test bun test ./test/integration/<file>`.

## Configuration

Every setting is an environment variable, validated at start-up (`src/config/env.ts`). Compose sets them for the containers; [.env.example](.env.example) lists them all with their defaults and the reason for each value.

To run one instance on the host against the Compose dependencies:

```bash
docker compose up -d --wait postgres localstack
cp .env.example .env
bun run migrate up
bun run start
```

`bun run migrate down` reverts the latest migration.

## Repository layout

```text
src/
  domain/           Money, Wallet, WagerTransaction, WalletLedgerEntry, OutboxMessage, events (no ORM, no NestJS)
  application/      Use cases and their ports
  infrastructure/   HTTP, SQS consumer, outbox publisher, workers, MikroORM records and migrations, logging, metrics
  main.ts           One instance: HTTP, consumer and the two workers
  migrate.ts        Migration runner
test/
  unit/  integration/  concurrency/  load/  support/
infra/              LocalStack and PostgreSQL init scripts
docs/               Statement, requirements matrix, plan, slice task lists, progress log, load test
```

## Not implemented

- **Authentication** (statement §2, no points). The extension point is in the code: a global no-op `AuthGuard` and a `ProviderIdentityPort` that the use case consults before opening the transaction; the Keycloak design is in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-authentication-design-not-implemented).
- **OpenTelemetry and a dashboard** (optional).

The limitations of what is implemented are listed in [ARCHITECTURE.md §9](ARCHITECTURE.md#9-known-limitations).
