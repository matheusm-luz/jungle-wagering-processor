import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { startApp, type TestApp } from '../support/app';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { newId } from '../support/schema-fixtures';

setDefaultTimeout(30_000);

let app: TestApp;
let sql: SQL;
let queues: TestQueues;

beforeAll(async () => {
  sql = await migratedDatabase();
  queues = await createTestQueues('s11-metrics');
  app = await startApp({
    ...queues.env,
    SQS_CONSUMER_CONCURRENCY: 1,
    SQS_WAIT_TIME_S: 1,
    SQS_VISIBILITY_TIMEOUT_S: 5,
    SQS_RETRY_BASE_DELAY_S: 0,
    SQS_RETRY_MAX_DELAY_S: 0,
    DATABASE_LOCK_TIMEOUT_MS: 200,
  });
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await app.close();
  await queues.remove();
  await sql.close();
});

const PROVIDER = 'provider-s11';

/** Statement §12: transactions by status, duplicates, retries, DLQ, lock conflicts, outbox lag, latency. */
const REQUIRED = [
  'wager_transactions_total',
  'wager_duplicates_total',
  'retries_total',
  'sqs_dead_lettered_total',
  'sqs_dlq_messages',
  'lock_conflicts_total',
  'wallet_lock_wait_seconds',
  'outbox_lag_seconds',
  'outbox_pending_messages',
  'outbox_max_attempts',
  'wager_transaction_processing_seconds',
];

interface Wallet {
  id: string;
  playerId: string;
}

type Body = Record<string, unknown>;

async function openWallet(amount = '100.00'): Promise<Wallet> {
  const response = await fetch(`${app.url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: `player-${newId()}`,
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Wallet;
}

function wager(wallet: Wallet, kind: string, amount: string, overrides: Body = {}): Body {
  return {
    providerId: PROVIDER,
    externalTransactionId: `tx-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

async function submit(body: Body, target: TestApp = app): Promise<number> {
  const response = await fetch(`${target.url}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
    },
    body: JSON.stringify(body),
  });
  await response.body?.cancel();
  return response.status;
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}

/** The current value of each named series, to compare after the events of a test. */
async function snapshot<K extends string>(
  series: Record<K, [string, Record<string, string>?]>,
): Promise<Record<K, number>> {
  const values = {} as Record<K, number>;
  for (const key of Object.keys(series) as K[]) {
    const [name, labels] = series[key];
    values[key] = await app.metricValue(name, labels);
  }
  return values;
}

async function status(transactionExternalId: string) {
  const [row] = await sql`
    select status from wager_transactions where external_transaction_id = ${transactionExternalId}`;
  return row?.status as string | undefined;
}

describe('GET /metrics (R-61)', () => {
  test('answers the Prometheus text format with every required family, without authentication', async () => {
    const response = await fetch(`${app.url}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/plain; version=0.0.4');
    const text = await response.text();
    for (const name of REQUIRED) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });
});

describe('transactions by status and processing latency (R-61)', () => {
  const HTTP = {
    processed: ['wager_transactions_total', { channel: 'http', status: 'PROCESSED' }],
    rejected: ['wager_transactions_total', { channel: 'http', status: 'REJECTED' }],
    pending: ['wager_transactions_total', { channel: 'http', status: 'PENDING_REFERENCE' }],
    timed: ['wager_transaction_processing_seconds_count', { channel: 'http' }],
  } satisfies Record<string, [string, Record<string, string>]>;

  test('a processed BET, a rejected BET and a pending REFUND count by status; a replay is timed, not counted', async () => {
    const wallet = await openWallet('100.00');
    const before = await snapshot(HTTP);

    const bet = wager(wallet, 'BET', '30.00');
    expect(await submit(bet)).toBe(200);
    expect(await submit(wager(wallet, 'BET', '500.00'))).toBe(422);
    const refund = wager(wallet, 'REFUND', '10.00', {
      referenceExternalTransactionId: `tx-${newId()}`,
    });
    expect(await submit(refund)).toBe(202);
    expect(await submit(bet)).toBe(200);

    const after = await snapshot(HTTP);
    expect(after.processed - before.processed).toBe(1);
    expect(after.rejected - before.rejected).toBe(1);
    expect(after.pending - before.pending).toBe(1);
    expect(after.timed - before.timed).toBe(4);
  });

  test('an SQS message counts on the sqs channel', async () => {
    const wallet = await openWallet('100.00');
    const series = {
      processed: ['wager_transactions_total', { channel: 'sqs', status: 'PROCESSED' }],
      timed: ['wager_transaction_processing_seconds_count', { channel: 'sqs' }],
    } satisfies Record<string, [string, Record<string, string>]>;
    const before = await snapshot(series);

    const bet = wager(wallet, 'BET', '30.00');
    const messageId = `msg-${newId()}`;
    await queues.sendRaw(
      JSON.stringify(
        wagerMessage(
          { ...bet, idempotencyKey: `${PROVIDER}:${bet.externalTransactionId}` },
          messageId,
        ),
      ),
      { groupId: wallet.id },
    );
    await waitFor(async () =>
      (await status(String(bet.externalTransactionId))) === 'PROCESSED' ? true : undefined,
    );

    const after = await waitFor(async () => {
      const now = await snapshot(series);
      return now.timed > before.timed ? now : undefined;
    });
    expect(after.processed - before.processed).toBe(1);
    expect(after.timed - before.timed).toBe(1);
  });

  test('a REFUND rescheduled by the worker counts a pending_reference retry, then PROCESSED on the worker channel', async () => {
    const worker = await startApp({
      PENDING_REFERENCE_BASE_DELAY_MS: 50,
      PENDING_REFERENCE_MAX_DELAY_MS: 200,
      PENDING_REFERENCE_MAX_ATTEMPTS: 50,
      PENDING_REFERENCE_POLL_INTERVAL_MS: 20,
    });
    try {
      const wallet = await openWallet('100.00');
      const resolved = () =>
        worker.metricValue('wager_transactions_total', { channel: 'worker', status: 'PROCESSED' });
      const retries = () => worker.metricValue('retries_total', { source: 'pending_reference' });
      const before = { resolved: await resolved(), retries: await retries() };

      const bet = wager(wallet, 'BET', '30.00');
      const refund = wager(wallet, 'REFUND', '30.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(await submit(refund)).toBe(202);
      const [row] = await sql`
        select id from wager_transactions
         where external_transaction_id = ${String(refund.externalTransactionId)}`;
      const refundId = String(row?.id);
      // Its BET is sent only once the worker has rescheduled this REFUND, not some other row of the
      // shared database (S11 review, m5).
      await waitFor(async () => {
        const [current] = await sql`
          select reference_attempts from wager_transactions where id = ${refundId}`;
        return Number(current?.reference_attempts) >= 1 ? true : undefined;
      });
      expect(await retries()).toBeGreaterThan(before.retries);
      expect(await submit(bet)).toBe(200);

      await waitFor(async () =>
        (await status(String(refund.externalTransactionId))) === 'PROCESSED' ? true : undefined,
      );
      expect(await resolved()).toBeGreaterThanOrEqual(before.resolved + 1);
      // The PROCESSED counted is this REFUND's: the worker logged its resolution.
      expect(worker.logs()).toContainEqual(
        expect.objectContaining({
          message: 'pending reference retried',
          transactionId: refundId,
          outcome: 'PROCESSED',
        }),
      );
    } finally {
      await worker.close();
    }
  });
});

describe('duplicates, retries and the DLQ (R-61)', () => {
  test('an HTTP replay counts one duplicate on the http channel', async () => {
    const wallet = await openWallet('100.00');
    const before = await app.metricValue('wager_duplicates_total', { channel: 'http' });

    const bet = wager(wallet, 'BET', '30.00');
    expect(await submit(bet)).toBe(200);
    expect(await submit(bet)).toBe(200);

    expect(await app.metricValue('wager_duplicates_total', { channel: 'http' })).toBe(before + 1);
  });

  test('a message the consumer dead-letters counts once and shows in the DLQ depth', async () => {
    const before = {
      deadLettered: await app.metricValue('sqs_dead_lettered_total'),
      depth: await app.metricValue('sqs_dlq_messages'),
    };

    await queues.sendRaw('not json', { groupId: `group-${newId()}` });

    await waitFor(async () =>
      (await app.metricValue('sqs_dead_lettered_total')) > before.deadLettered ? true : undefined,
    );
    expect(await app.metricValue('sqs_dead_lettered_total')).toBe(before.deadLettered + 1);
    expect(await app.metricValue('sqs_dlq_messages')).toBe(before.depth + 1);
  });
});

describe('lock conflicts (R-61)', () => {
  test('a wallet held past the lock timeout counts one lock conflict and a lock wait of at least the timeout', async () => {
    const wallet = await openWallet('100.00');
    const series = {
      conflicts: ['lock_conflicts_total'],
      waits: ['wallet_lock_wait_seconds_count'],
      waited: ['wallet_lock_wait_seconds_sum'],
    } satisfies Record<string, [string]>;
    const before = await snapshot(series);

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${wallet.id} for update`;
      locked();
      await held;
    });
    try {
      await isLocked;
      // 55P03 after DATABASE_LOCK_TIMEOUT_MS (200 ms): not an answer of ARCHITECTURE §6, so a 500.
      expect(await submit(wager(wallet, 'BET', '30.00'))).toBe(500);
    } finally {
      release();
      await holder;
    }

    const after = await snapshot(series);
    expect(after.conflicts - before.conflicts).toBe(1);
    expect(after.waits - before.waits).toBe(1);
    expect(after.waited - before.waited).toBeGreaterThanOrEqual(0.2);
  });
});

describe('outbox (R-61)', () => {
  beforeAll(async () => {
    // Rows other suites left unpublished in the shared database are not this file's events.
    await sql`update outbox_messages set published_at = now() where published_at is null`;
  });

  test('with nothing pending the lag is 0; an unpublished event 30 s old shows a lag of at least 30 s', async () => {
    expect(await app.metricValue('outbox_lag_seconds')).toBe(0);
    expect(await app.metricValue('outbox_pending_messages')).toBe(0);

    const wallet = await openWallet('100.00');
    await sql`
      update outbox_messages set occurred_at = now() - interval '30 seconds'
       where aggregate_id = ${wallet.id}`;

    expect(await app.metricValue('outbox_lag_seconds')).toBeGreaterThanOrEqual(30);
    expect(await app.metricValue('outbox_pending_messages')).toBeGreaterThanOrEqual(1);
    await sql`update outbox_messages set published_at = now() where aggregate_id = ${wallet.id}`;
  });

  test('an event stamped by an instance whose clock runs ahead of the database shows a lag of 0, never negative (S11 review, m2)', async () => {
    const wallet = await openWallet('100.00');
    await sql`
      update outbox_messages set occurred_at = now() + interval '30 seconds'
       where aggregate_id = ${wallet.id}`;

    expect(await app.metricValue('outbox_lag_seconds')).toBe(0);
    await sql`update outbox_messages set published_at = now() where aggregate_id = ${wallet.id}`;
  });

  test('a publish to a missing topic counts outbox retries and the highest attempts', async () => {
    const broken = await startApp({
      WAGER_EVENTS_TOPIC_ARN: 'arn:aws:sns:us-east-1:000000000000:s11-missing.fifo',
      OUTBOX_POLL_INTERVAL_MS: 20,
      OUTBOX_RETRY_BASE_DELAY_MS: 20,
      OUTBOX_RETRY_MAX_DELAY_MS: 20,
    });
    try {
      const wallet = await openWallet('100.00');
      expect(await submit(wager(wallet, 'BET', '30.00'), broken)).toBe(200);

      await waitFor(async () =>
        (await broken.metricValue('outbox_max_attempts')) >= 2 ? true : undefined,
      );
      expect(
        await broken.metricValue('retries_total', { source: 'outbox' }),
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await broken.close();
      await sql`update outbox_messages set published_at = now() where published_at is null`;
    }
  });
});
