import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cpus, totalmem } from 'node:os';
import type { SQL } from 'bun';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { type AppProcesses, startProcesses } from '../support/processes';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { newId, seedWallet } from '../support/schema-fixtures';
import { createTestTopic, type TestTopic } from '../support/topics';

/**
 * R-76, statement §14: a load experiment, not a pass/fail benchmark. It reports and fails only if
 * the ledger invariant breaks. Methodology and results: docs/LOAD-TEST.md.
 */
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 60);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 48);
const SQS_RATE = Number(process.env.LOAD_SQS_RATE ?? 20);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 500);
const HOT_SHARE = Number(process.env.LOAD_HOT_SHARE ?? 0.05);
const PROVIDER = 'provider-load';

let sql: SQL;
let processes: AppProcesses;
let queues: TestQueues;
let topic: TestTopic;

beforeAll(async () => {
  sql = await migratedDatabase();
  queues = await createTestQueues('load');
  // A private topic: about 150 000 events must not land in the real subscriber queue.
  topic = await createTestTopic('load');
  // The outbox publisher and the pending-reference worker run at their production settings.
  processes = await startProcesses(3, {
    ...queues.env,
    ...topic.env,
    OUTBOX_POLL_INTERVAL_MS: '500',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '500',
  });
}, 60_000);

afterAll(async () => {
  try {
    await expectLedgerInvariant(sql);
  } finally {
    await processes?.stop();
    await queues?.remove();
    await topic?.remove();
    await sql?.close();
  }
}, 120_000);

interface Wallet {
  id: string;
  playerId: string;
}

interface Sent {
  body: Record<string, unknown>;
  key: string;
}

/** Sum of a metric family over the three processes (counters are per process, ADR-14). */
async function metric(name: string, urls: readonly string[] = processes.urls): Promise<number> {
  let total = 0;
  for (const url of urls) {
    const text = await (await fetch(`${url}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith(`${name} `) || line.startsWith(`${name}{`)) {
        total += Number(line.slice(line.lastIndexOf(' ') + 1));
      }
    }
  }
  return total;
}

/** A gauge every process reads from the same database: one process is enough. */
const gauge = (name: string) => metric(name, processes.urls.slice(0, 1));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

async function waitFor(read: () => Promise<boolean>, timeoutMs: number): Promise<number> {
  const started = performance.now();
  while (!(await read())) {
    if (performance.now() - started > timeoutMs) return Number.NaN;
    await Bun.sleep(250);
  }
  return (performance.now() - started) / 1000;
}

test(
  'load: mixed HTTP and SQS traffic over three processes',
  async () => {
    const wallets: Wallet[] = [];
    for (let i = 0; i < WALLETS; i++) {
      const { wallet } = await seedWallet(sql, '10000.00');
      wallets.push({ id: wallet.id as string, playerId: wallet.player_id as string });
    }
    const { wallet: hotRow } = await seedWallet(sql, '1000000.00');
    const hot: Wallet = { id: hotRow.id as string, playerId: hotRow.player_id as string };
    // Leftover rows of other suites would count as lag: start from an empty outbox.
    const warm = await waitFor(async () => (await gauge('outbox_pending_messages')) === 0, 60_000);
    expect(Number.isNaN(warm)).toBe(false);
    const conflictsBefore = await metric('lock_conflicts_total');
    const waitSumBefore = await metric('wallet_lock_wait_seconds_sum');
    const waitCountBefore = await metric('wallet_lock_wait_seconds_count');

    const pick = () => wallets[Math.floor(Math.random() * wallets.length)] as Wallet;
    const body = (wallet: Wallet, kind: string, amount: string) => ({
      providerId: PROVIDER,
      externalTransactionId: `tx-${newId()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${newId()}`,
      gameId: 'load',
      kind,
      money: { amount, currency: 'BRL' },
    });

    const latencies: number[] = [];
    const byLabel = new Map<string, number[]>();
    const statuses = new Map<string, number>();
    const count = (label: string) => statuses.set(label, (statuses.get(label) ?? 0) + 1);
    const sent: Sent[] = [];
    let lagMax = 0;
    let sqsSent = 0;
    const sqsIds: string[] = [];
    const deadline = performance.now() + DURATION_S * 1000;
    let request = 0;

    const virtualUser = async () => {
      while (performance.now() < deadline) {
        const r = Math.random();
        let next: Sent;
        let label: string;
        if (r < 0.05 && sent.length > 0) {
          next = sent[Math.floor(Math.random() * sent.length)] as Sent;
          label = 'replay';
        } else {
          const b =
            r < 0.05 + HOT_SHARE
              ? body(hot, 'BET', '0.01')
              : r < 0.25
                ? body(pick(), 'WIN', '1.00')
                : body(pick(), 'BET', '1.00');
          next = { body: b, key: `${PROVIDER}:${b.externalTransactionId}` };
          label = b.walletId === hot.id ? 'hot BET' : (b.kind as string);
        }
        const url = processes.urls[request++ % processes.urls.length] as string;
        const started = performance.now();
        try {
          const response = await fetch(`${url}/wagering/transactions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': next.key },
            body: JSON.stringify(next.body),
          });
          await response.arrayBuffer();
          const ms = performance.now() - started;
          latencies.push(ms);
          const ofLabel = byLabel.get(label) ?? [];
          ofLabel.push(ms);
          byLabel.set(label, ofLabel);
          count(`${label} ${response.status}`);
          if (label !== 'replay' && response.status === 200) sent.push(next);
        } catch {
          count(`${label} network error`);
        }
      }
    };

    const sqsProducer = async () => {
      while (performance.now() < deadline) {
        const tick = performance.now();
        const wallet = pick();
        const b = body(wallet, 'BET', '1.00');
        sqsIds.push(b.externalTransactionId);
        await queues.sendRaw(
          JSON.stringify(
            wagerMessage({ ...b, idempotencyKey: `${PROVIDER}:${b.externalTransactionId}` }),
          ),
          { groupId: wallet.id },
        );
        sqsSent++;
        await Bun.sleep(Math.max(0, 1000 / SQS_RATE - (performance.now() - tick)));
      }
    };

    const lagSampler = async () => {
      while (performance.now() < deadline) {
        lagMax = Math.max(lagMax, await gauge('outbox_lag_seconds'));
        await Bun.sleep(500);
      }
    };

    const started = performance.now();
    await Promise.all([
      ...Array.from({ length: CONCURRENCY }, virtualUser),
      sqsProducer(),
      lagSampler(),
    ]);
    const elapsed = (performance.now() - started) / 1000;

    const sqsDrain = await waitFor(async () => {
      const [{ n }] =
        await sql`select count(*)::int as n from wager_transactions where provider_id = ${PROVIDER} and external_transaction_id in ${sql(sqsIds)}`;
      return n === sqsIds.length;
    }, 120_000);
    const outboxDrain = await waitFor(
      async () => (await gauge('outbox_pending_messages')) === 0,
      120_000,
    );
    const conflicts = (await metric('lock_conflicts_total')) - conflictsBefore;
    // Contention below the lock timeout: every wallet lock taken, and how long it was waited for.
    const waitSum = (await metric('wallet_lock_wait_seconds_sum')) - waitSumBefore;
    const waitCount = (await metric('wallet_lock_wait_seconds_count')) - waitCountBefore;

    latencies.sort((a, b) => a - b);
    const total = [...statuses.values()].reduce((a, b) => a + b, 0);
    const errors = [...statuses].filter(([k]) => !/ (200|202|422)$/.test(k));
    const errorCount = errors.reduce((a, [, v]) => a + v, 0);
    const fmt = (ms: number) => `${ms.toFixed(1)} ms`;
    const report = [
      '## Load test result',
      '',
      `Environment: ${cpus().length} CPUs and ${(totalmem() / 2 ** 30).toFixed(1)} GiB visible to the test container, Bun ${Bun.version}; three application processes, one PostgreSQL, one LocalStack.`,
      `Workload: ${DURATION_S} s, ${CONCURRENCY} closed-loop HTTP clients round-robin over the processes, ${SQS_RATE} SQS messages/s, ${WALLETS} wallets plus one hot wallet (${HOT_SHARE * 100} % of requests).`,
      '',
      '| Measure | Value |',
      '| --- | --- |',
      `| HTTP requests | ${total} in ${elapsed.toFixed(1)} s |`,
      `| HTTP throughput | ${(total / elapsed).toFixed(0)} req/s |`,
      `| Latency p50 / p95 / p99 / max | ${fmt(percentile(latencies, 50))} / ${fmt(percentile(latencies, 95))} / ${fmt(percentile(latencies, 99))} / ${fmt(latencies.at(-1) ?? Number.NaN)} |`,
      `| Error rate (any status but 200, 202, 422) | ${((100 * errorCount) / Math.max(1, total)).toFixed(2)} % (${errorCount}) |`,
      `| Lock conflicts (55P03, all processes) | ${conflicts} |`,
      `| Wallet lock waits: locks taken / mean wait / total wait | ${waitCount} / ${fmt((1000 * waitSum) / Math.max(1, waitCount))} / ${waitSum.toFixed(1)} s |`,
      `| Outbox lag, max sampled during the run | ${lagMax.toFixed(2)} s |`,
      `| Outbox drained after the run | ${outboxDrain.toFixed(1)} s |`,
      `| SQS messages sent / all applied after the run | ${sqsSent} / ${sqsDrain.toFixed(1)} s |`,
      '',
      '| Kind | p50 / p95 / p99 |',
      '| --- | --- |',
      ...[...byLabel].sort().map(([k, v]) => {
        v.sort((a, b) => a - b);
        return `| ${k} | ${fmt(percentile(v, 50))} / ${fmt(percentile(v, 95))} / ${fmt(percentile(v, 99))} |`;
      }),
      '',
      '| Outcome | Count |',
      '| --- | --- |',
      ...[...statuses].sort().map(([k, v]) => `| ${k} | ${v} |`),
    ].join('\n');
    console.log(`\n${report}\n`);

    expect(Number.isNaN(sqsDrain)).toBe(false);
  },
  (DURATION_S + 300) * 1000,
);
