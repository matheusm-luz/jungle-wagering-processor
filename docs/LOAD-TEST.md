# Load test

Optional differential of statement §14 (R-76). The goal is an honest experiment, not a number to beat: what the service does under sustained mixed load, where it saturates first, and whether money stays correct while it does.

## How to run

```bash
docker compose up -d --build --wait   # PostgreSQL and LocalStack must be up
bun run test:load
```

The run lasts about two minutes and prints the report below. It passes unless the warm-up cannot empty the outbox within 60 s, the SQS messages are not all applied, or the ledger invariant fails; the numbers themselves are reported, not asserted. Parameters are environment variables of the `test` container:

```bash
docker compose --profile test run --rm --build -e LOAD_HOT_SHARE=0.5 test bun test ./test/load
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOAD_DURATION_S` | 60 | Length of the measured window |
| `LOAD_CONCURRENCY` | 48 | Closed-loop HTTP clients (each sends its next request when the previous one answers) |
| `LOAD_SQS_RATE` | 20 | Messages per second sent to the consumer's queue |
| `LOAD_WALLETS` | 500 | Ordinary wallets, opened with 10 000.00 |
| `LOAD_HOT_SHARE` | 0.05 | Share of HTTP requests sent to one hot wallet |

## Methodology

- **Topology.** Inside the `test` container (`test/load/load.test.ts`): three real `bun src/main.ts` processes (the same harness as the concurrency suite, ADR-09) against the Compose PostgreSQL and LocalStack. Every process serves HTTP, consumes SQS, runs the pending-reference worker and the outbox publisher at their production settings (poll 500 ms, batches of 10). The queue and the SNS FIFO topic (with one FIFO subscriber queue, as in `infra/localstack/init`) are private to the run, so its events never reach the stack's real subscriber.
- **Load.** HTTP clients send round-robin to the three processes. Each request is a `BET` of 1.00 on a random ordinary wallet (about 75 %), a `WIN` of 1.00 (about 15 %), a `BET` of 0.01 on the hot wallet (`LOAD_HOT_SHARE`), or a replay of an earlier request with the same key and body (5 %). Meanwhile a producer sends `BET` messages to a fresh SQS FIFO queue, one group per wallet.
- **Warm-up.** Wallets are seeded through SQL, and the run starts only when the outbox is empty (it fails if that takes more than 60 s), so rows left by other suites do not count as lag.
- **Measured.** Client-side latency of every HTTP request (`performance.now()` around `fetch`, body read included); throughput as requests answered over the window; error rate as any status other than 200, 202 and 422 (the workload produces no 4xx by design, so a 409 or a 400 would be a bug), plus network errors; lock conflicts as the increase of `lock_conflicts_total` summed over the three processes' `/metrics`, and the contention below the lock timeout as the increase of `wallet_lock_wait_seconds` (count, sum and their ratio: every wallet lock taken by HTTP, SQS and the worker, and how long it was waited for); outbox lag as the highest `outbox_lag_seconds` sampled every 500 ms; after the window, the time until every SQS message is applied and the time until the outbox is empty.
- **Proof of correctness.** The run ends with the ledger invariant of every suite (`expectLedgerInvariant`): every wallet's balance equals the balance rebuilt from its ledger, versions match the last sequence, and the trial balance holds.

## Environment

Windows 11 host, Docker Desktop on WSL2 with 16 CPUs and about 30 GiB; Bun 1.4.4; PostgreSQL 17 (`postgres:17-alpine`, default settings); LocalStack 4.12. Load generator, three application processes, PostgreSQL and LocalStack share the same machine, so the generator competes for CPU with what it measures. Results on 14 Nov 2026.

## Results

### Scenario A: spread load (defaults, 5 % on the hot wallet)

| Measure | Value |
| --- | --- |
| HTTP requests | 81 610 in 60.1 s |
| HTTP throughput | 1 359 req/s |
| Latency p50 / p95 / p99 / max | 29.0 ms / 75.9 ms / 192.9 ms / 672.5 ms |
| Error rate | 0.00 % (0) |
| Lock conflicts (55P03) | 0 |
| Wallet lock waits: locks taken / mean wait / total wait | 82 812 / 7.3 ms / 603.0 s |
| Outbox lag, max during the run | 35.93 s |
| Outbox drained after the run | 44.3 s |
| SQS messages sent / all applied | 1 201 / already applied when the window closed |

| Kind | p50 / p95 / p99 |
| --- | --- |
| `BET` | 28.5 / 56.1 / 74.2 ms |
| `WIN` | 28.4 / 56.2 / 76.2 ms |
| Hot `BET` | 137.4 / 240.4 / 300.6 ms |
| Replay | 22.8 / 71.7 / 186.9 ms |

Outcomes: 61 180 `BET`, 12 270 `WIN`, 4 152 hot `BET` and 4 008 replays, all 200. Ledger invariant: held.

### Scenario B: hot wallet (`LOAD_HOT_SHARE=0.5`)

| Measure | Value |
| --- | --- |
| HTTP requests | 30 075 in 60.4 s |
| HTTP throughput | 498 req/s |
| Latency p50 / p95 / p99 / max | 74.7 ms / 246.8 ms / 294.9 ms / 444.0 ms |
| Error rate | 0.00 % (0) |
| Lock conflicts (55P03) | 0 |
| Wallet lock waits: locks taken / mean wait / total wait | 31 279 / 51.3 ms / 1 606.1 s |
| Outbox lag, max during the run | 0.70 s |
| Outbox drained after the run | 0.0 s |
| SQS messages sent / all applied | 1 203 / already applied when the window closed |

| Kind | p50 / p95 / p99 |
| --- | --- |
| `BET` | 37.4 / 102.2 / 126.3 ms |
| Hot `BET` | 138.6 / 268.4 / 313.3 ms |
| Replay | 72.3 / 248.9 / 282.9 ms |

Outcomes: 13 447 `BET`, 15 160 hot `BET` and 1 468 replays, all 200 (with half the traffic on the hot wallet, the `WIN` share of the mix is absorbed by it). Ledger invariant: held.

**Variation between runs.** The same scenario B, run earlier the same day on the same machine before the lock-wait line was added, gave 335 req/s, 166 hot `BET`/s and a hot p99 of 949 ms; scenario A moved less (1 197 to 1 359 req/s across four runs). The machine also runs the generator and everything else, so single runs differ by up to half; the conclusions below hold in every run, the exact figures do not.

## Reading

- **Correctness held under load.** 112 000 requests and 2 400 queue messages across three processes, no error, no lock timeout, and the ledger invariant at the end of both runs. Replays answered 200 with the stored result.
- **The first bottleneck is the outbox publisher, not the money path.** In scenario A the service commits about 1 290 transactions per second, each with two events (`WagerTransactionProcessed` and `WalletBalanceChanged`), so about 2 600 events/s enter the outbox. Each instance runs one publisher loop that sends one `PublishBatch` of 10 and starts the next batch at once when the batch was full (ADR-04); three loops drained about 1 500 events/s here. The lag grows linearly during the window (36 s at the end) and the backlog drains in 44 s after it. No event is lost or published before commit; they are late. Remedies, none built: several publisher loops per instance (the `SKIP LOCKED` scan already allows it), or more instances. In scenario B fewer transactions are committed and the publisher keeps up (0.7 s).
- **A hot wallet is serial by design (ADR-01).** In scenario B the hot wallet processed about 251 `BET`/s, about 4 ms per transaction under its row lock (166/s and 6 ms in the earlier run), whatever the number of instances. The lock waits show the queue in front of it: 1 606 s of waiting in a 60 s window means that, on average, 27 of the 48 clients were waiting for a wallet lock at any moment (10 in scenario A). Ordinary wallets slow down too (p50 28 → 37 ms) because hot requests hold pool connections while they wait. No wait reached the 5 s `lock_timeout`, so `lock_conflicts_total` stayed 0; past that, the waiting requests would be 503 with `Retry-After` and counted there.
- **SQS kept up.** 20 messages/s are well within five consumer loops per instance; every message was applied before the window closed.
- **Limits of the experiment.** One machine runs everything, so absolute numbers say little about production capacity and vary between runs (above); the generator is closed-loop, so latency is measured under the throughput the service could sustain, not at a fixed arrival rate (no coordinated-omission correction); PostgreSQL runs with default settings on a Docker volume; LocalStack is not SNS, and its `PublishBatch` latency bounds the publisher figure above; the lock-wait mean mixes ordinary and hot wallets, since the histogram has no wallet label.
