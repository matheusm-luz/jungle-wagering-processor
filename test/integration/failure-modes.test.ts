import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import type { SQL } from 'bun';
import type { Env } from '../../src/config/env';
import { startApp, type TestApp } from '../support/app';
import { migratedDatabase, testEnv } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { newId } from '../support/schema-fixtures';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy';
import { createTestTopic, type TestTopic } from '../support/topics';

setDefaultTimeout(30_000);

let sql: SQL;
let app: TestApp | undefined;
let proxy: TcpProxy | undefined;
let queues: TestQueues;
let topic: TestTopic;

beforeAll(async () => {
  sql = await migratedDatabase();
  queues = await createTestQueues('s12-failures');
  topic = await createTestTopic('s12-failures');
});

afterEach(async () => {
  proxy?.restore();
  await app?.close();
  app = undefined;
  proxy?.stop();
  proxy = undefined;
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await queues.remove();
  await topic.remove();
  await sql.close();
});

const PROVIDER = 'provider-s12';

interface Wallet {
  id: string;
  playerId: string;
}

/** `url` with its host and port replaced by the proxy's. */
function throughProxy(url: string): { url: string; proxy: TcpProxy } {
  const parsed = new URL(url);
  const started = startTcpProxy(parsed.hostname, Number(parsed.port));
  parsed.host = started.address;
  return { url: parsed.toString(), proxy: started };
}

async function start(overrides: Partial<Env> = {}): Promise<TestApp> {
  app = await startApp(overrides);
  return app;
}

async function openWallet(on: TestApp, amount = '100.00'): Promise<Wallet> {
  const response = await fetch(`${on.url}/wallets`, {
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

function bet(wallet: Wallet, amount: string) {
  const externalTransactionId = `tx-${newId()}`;
  return {
    key: `${PROVIDER}:${externalTransactionId}`,
    body: {
      providerId: PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  };
}

function submit(on: TestApp, { key, body }: ReturnType<typeof bet>) {
  return fetch(`${on.url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

async function expectUnavailable(response: Response): Promise<void> {
  expect({
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: await response.json(),
  }).toEqual({
    status: 503,
    retryAfter: '1',
    body: { code: 'SERVICE_UNAVAILABLE', message: expect.any(String) },
  });
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql`select balance from wallets where id = ${walletId}`;
  return row.balance as string;
}

async function transactionsOf(walletId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from wager_transactions where wallet_id = ${walletId} and kind = 'BET'`;
  return row.n as number;
}

/** Holds the wallet row `FOR UPDATE` in another session until `release` is called. */
async function holdWallet(walletId: string): Promise<{ release: () => Promise<void> }> {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = () => {};
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = sql.begin(async (tx) => {
    await tx`select id from wallets where id = ${walletId} for update`;
    locked();
    await held;
  });
  await isLocked;
  return {
    release: async () => {
      release();
      await holder;
    },
  };
}

describe('transient database failures over HTTP (ADR-05)', () => {
  test('a BET on a wallet held past the lock timeout is 503 with Retry-After, and resending it with the same key after the lock is released processes it once', async () => {
    const on = await start({ DATABASE_LOCK_TIMEOUT_MS: 200, DATABASE_STATEMENT_TIMEOUT_MS: 5000 });
    const wallet = await openWallet(on);
    const request = bet(wallet, '30.00');

    const hold = await holdWallet(wallet.id);
    try {
      await expectUnavailable(await submit(on, request));
    } finally {
      await hold.release();
    }
    expect(await transactionsOf(wallet.id)).toBe(0);

    const resent = await submit(on, request);
    expect(resent.status).toBe(200);
    expect(await submit(on, request).then((r) => r.status)).toBe(200);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    expect(await transactionsOf(wallet.id)).toBe(1);
    // The 503 is logged without the driver's message (S6 review, m2).
    const line = on.logs().find((entry) => entry.message === 'request failed, service unavailable');
    expect(line).toMatchObject({ errorName: expect.any(String), errorCode: '55P03' });
    expect(JSON.stringify(line)).not.toContain('lock timeout');
  });

  test('a request that finds the pool exhausted is 503, and resending it processes it once', async () => {
    // Ten connections (the pool's max) wait for the held wallet; the rest wait for a connection.
    const on = await start({
      DATABASE_CONNECT_TIMEOUT_MS: 300,
      DATABASE_LOCK_TIMEOUT_MS: 4000,
      DATABASE_STATEMENT_TIMEOUT_MS: 5000,
    });
    const wallet = await openWallet(on);
    const requests = Array.from({ length: 12 }, () => bet(wallet, '1.00'));

    const hold = await holdWallet(wallet.id);
    let answers: { status: number; ms: number }[];
    try {
      const started = performance.now();
      const pending = requests.map((request) =>
        submit(on, request).then(async (response) => {
          const ms = performance.now() - started;
          if (response.status === 503) await expectUnavailable(response);
          return { status: response.status, ms };
        }),
      );
      await Bun.sleep(1500);
      await hold.release();
      answers = await Promise.all(pending);
    } finally {
      await hold.release();
    }

    const unavailable = answers.filter((answer) => answer.status === 503);
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
    // Refused while the wallet was still held: the pool, not the lock, answered them.
    for (const answer of unavailable) expect(answer.ms).toBeLessThan(1500);
    expect(answers.every((answer) => answer.status === 200 || answer.status === 503)).toBe(true);

    for (const request of requests) expect((await submit(on, request)).status).toBe(200);
    expect(await balanceOf(wallet.id)).toBe('88.00');
    expect(await transactionsOf(wallet.id)).toBe(12);
  });

  test('a request while PostgreSQL is unreachable is 503 and the instance is not ready; once it returns, the same key is processed once', async () => {
    const database = throughProxy(testEnv.DATABASE_URL);
    proxy = database.proxy;
    const on = await start({ DATABASE_URL: database.url, DATABASE_CONNECT_TIMEOUT_MS: 1000 });
    const wallet = await openWallet(on);
    const request = bet(wallet, '25.00');

    database.proxy.cut();
    await expectUnavailable(await submit(on, request));
    const ready = await fetch(`${on.url}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ checks: { postgres: 'down' } });

    database.proxy.restore();
    expect((await submit(on, request)).status).toBe(200);
    expect((await fetch(`${on.url}/health/ready`)).status).toBe(200);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await transactionsOf(wallet.id)).toBe(1);
  });
});

/** Polls `read` until it returns a value. */
async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}

function logged(on: TestApp, message: string, times = 1): true | undefined {
  return on.logs().filter((line) => line.message === message).length >= times ? true : undefined;
}

/** A consumer whose failed message comes back after 1 s, and a publisher that polls often. */
const MESSAGING: Partial<Env> = {
  SQS_CONSUMER_CONCURRENCY: 1,
  SQS_WAIT_TIME_S: 1,
  SQS_VISIBILITY_TIMEOUT_S: 5,
  SQS_RETRY_BASE_DELAY_S: 1,
  SQS_RETRY_MAX_DELAY_S: 1,
  OUTBOX_POLL_INTERVAL_MS: 50,
  OUTBOX_RETRY_BASE_DELAY_MS: 100,
  OUTBOX_RETRY_MAX_DELAY_MS: 500,
};

async function sendBet(wallet: Wallet, amount: string): Promise<string> {
  const { body } = bet(wallet, amount);
  const data = { ...body, idempotencyKey: `${PROVIDER}:${body.externalTransactionId}` };
  await queues.sendRaw(JSON.stringify(wagerMessage(data)), { groupId: wallet.id });
  return body.externalTransactionId;
}

async function processedOnce(externalTransactionId: string): Promise<true | undefined> {
  const rows = await sql`
    select status from wager_transactions
     where provider_id = ${PROVIDER} and external_transaction_id = ${externalTransactionId}`;
  if (rows.length === 0) return undefined;
  expect(rows.map((row: { status: string }) => row.status)).toEqual(['PROCESSED']);
  return true;
}

describe('a database host that does not resolve (S12 review)', () => {
  test('a request is 503 and the instance is not ready, as when a stopped Compose service leaves the network', async () => {
    const url = new URL(testEnv.DATABASE_URL);
    url.hostname = 'postgres-stopped.invalid';
    const on = await start({ DATABASE_URL: url.toString(), DATABASE_CONNECT_TIMEOUT_MS: 1000 });

    await expectUnavailable(
      await submit(on, bet({ id: newId(), playerId: `player-${newId()}` }, '5.00')),
    );
    expect((await fetch(`${on.url}/health/ready`)).status).toBe(503);
  });
});

describe('messaging while a dependency is unreachable (R-63)', () => {
  test('the consumer survives SQS being unreachable and processes the waiting message once it returns', async () => {
    const aws = throughProxy(testEnv.AWS_ENDPOINT_URL as string);
    proxy = aws.proxy;
    aws.proxy.cut();
    const on = await start({ ...MESSAGING, ...queues.env, AWS_ENDPOINT_URL: aws.url });
    const wallet = await openWallet(on);

    const externalId = await sendBet(wallet, '10.00');
    // It keeps trying, a second apart, without crashing.
    await waitFor(() => logged(on, 'sqs receive failed', 2));
    expect(await processedOnce(externalId)).toBeUndefined();

    aws.proxy.restore();
    await waitFor(() => processedOnce(externalId));
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await queues.depth(queues.dlqUrl)).toBe(0);
  });

  test('events committed while SNS is unreachable are published once it returns', async () => {
    const aws = throughProxy(testEnv.AWS_ENDPOINT_URL as string);
    proxy = aws.proxy;
    const on = await start({ ...MESSAGING, ...topic.env, AWS_ENDPOINT_URL: aws.url });
    const wallet = await openWallet(on);
    aws.proxy.cut();

    const response = await submit(on, bet(wallet, '15.00'));
    expect(response.status).toBe(200);
    const { transactionId } = (await response.json()) as { transactionId: string };
    const pending = async () =>
      sql`select id, attempts, published_at from outbox_messages
           where aggregate_id in (${wallet.id}, ${transactionId})`;
    // Each failed publish is kept and rescheduled, never dropped.
    await waitFor(async () => {
      const rows = await pending();
      return rows.length > 0 && rows.every((row: { attempts: number }) => row.attempts >= 2)
        ? true
        : undefined;
    });

    aws.proxy.restore();
    await waitFor(async () => {
      const rows = await pending();
      return rows.every((row: { published_at: Date | null }) => row.published_at !== null)
        ? true
        : undefined;
    });
    const ids = (await pending()).map((row: { id: string }) => row.id).sort();
    const received = await topic.collect(
      (all) => ids.every((id: string) => all.some((event) => event.body.eventId === id)),
      10_000,
    );
    const mine = received.filter((event) => ids.includes(event.body.eventId));
    expect(mine.map((event) => event.body.eventId).sort()).toEqual(ids);
  });

  test('a message received while PostgreSQL is unreachable is retried and processed once it returns', async () => {
    const database = throughProxy(testEnv.DATABASE_URL);
    proxy = database.proxy;
    const on = await start({
      ...MESSAGING,
      ...queues.env,
      ...topic.env,
      DATABASE_URL: database.url,
      DATABASE_CONNECT_TIMEOUT_MS: 1000,
    });
    const wallet = await openWallet(on);
    database.proxy.cut();

    const externalId = await sendBet(wallet, '20.00');
    // Not acked: it comes back after its backoff. The publisher keeps polling too.
    await waitFor(() => logged(on, 'sqs message failed, retrying'));
    await waitFor(() => logged(on, 'outbox poll failed'));

    database.proxy.restore();
    await waitFor(() => processedOnce(externalId));
    expect(await balanceOf(wallet.id)).toBe('80.00');
    expect(await queues.depth(queues.dlqUrl)).toBe(0);
  });
});
