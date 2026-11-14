import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import { startApp, type TestApp } from '../support/app';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { newId, seedWallet } from '../support/schema-fixtures';

// Dead-lettering through the redrive policy takes five receive cycles.
setDefaultTimeout(30_000);

let sql: SQL;
let queues: TestQueues;
let app: TestApp;

beforeAll(async () => {
  sql = await migratedDatabase();
  queues = await createTestQueues('s9-consumer');
  app = await startApp({
    ...queues.env,
    SQS_CONSUMER_CONCURRENCY: 2,
    SQS_WAIT_TIME_S: 1,
    SQS_VISIBILITY_TIMEOUT_S: 5,
    // T1 proves the backoff formula; here a retry comes back at once.
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

const PROVIDER = 'provider-s9';

async function wallet(balance = '100.00') {
  const { wallet: row } = await seedWallet(sql, balance);
  return { id: row.id as string, playerId: row.player_id as string };
}

type Data = Record<string, unknown>;

function bet(
  target: { id: string; playerId: string },
  amount = '30.00',
  overrides: Data = {},
): Data {
  const externalTransactionId = `tx-${newId()}`;
  return {
    providerId: PROVIDER,
    externalTransactionId,
    idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
    playerId: target.playerId,
    walletId: target.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

/** Sends `data` in a statement §10 envelope; the wallet is the FIFO group (L-12). */
async function send(data: Data, messageId = `msg-${newId()}`): Promise<string> {
  await queues.sendRaw(JSON.stringify(wagerMessage(data, messageId)), {
    groupId: String(data.walletId ?? 'no-wallet'),
  });
  return messageId;
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

const drained = () =>
  waitFor(async () => ((await queues.depth(queues.url)) === 0 ? true : undefined));

async function inboxRow(messageId: string) {
  const [row] = await sql`select message_id from inbox_messages where message_id = ${messageId}`;
  return row;
}

async function walletState(walletId: string) {
  const [row] = await sql`
    select w.balance,
           (select count(*)::int from wager_transactions t
             where t.wallet_id = w.id and t.kind <> 'OPENING') as transactions
      from wallets w where w.id = ${walletId}`;
  return row;
}

/** Every DLQ message seen so far, by envelope message id (or raw body when unreadable). */
const deadLetters = new Map<string, Message>();

async function deadLettered(key: string, timeoutMs = 20_000): Promise<Message> {
  return waitFor(async () => {
    for (const message of await queues.take(queues.dlqUrl)) {
      const body = message.Body ?? '';
      let id = body;
      try {
        id = (JSON.parse(body) as { messageId?: string }).messageId ?? body;
      } catch {}
      deadLetters.set(id, message);
    }
    return deadLetters.get(key);
  }, timeoutMs);
}

const failureReason = (message: Message) => message.MessageAttributes?.failureReason?.StringValue;

/** Holds `walletId` locked `FOR UPDATE` until the returned release is called. */
async function holdWallet(walletId: string): Promise<() => Promise<void>> {
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
  return async () => {
    release();
    await holder;
  };
}

describe('SQS consumer: ack after commit (R-52, R-53, R-54)', () => {
  test('a BET message is processed, acked and leaves one debit', async () => {
    const target = await wallet();
    const data = bet(target);
    const messageId = await send(data);

    await waitFor(() => inboxRow(messageId));
    await drained();

    const [transaction] = await sql`
      select status, correlation_id from wager_transactions
       where external_transaction_id = ${data.externalTransactionId as string}`;
    expect(transaction).toEqual({ status: 'PROCESSED', correlation_id: messageId });
    expect(await walletState(target.id)).toEqual({ balance: '70.00', transactions: 1 });
  });

  test('the same message delivered twice has no second effect (R-53)', async () => {
    const target = await wallet();
    const data = bet(target);
    const messageId = `msg-${newId()}`;
    const duplicatesBefore = await app.metricValue('wager_duplicates_total', { channel: 'sqs' });

    // Two broker copies (distinct deduplication ids) of one envelope.
    await send(data, messageId);
    await send(data, messageId);

    await waitFor(async () =>
      (await app.metricValue('wager_duplicates_total', { channel: 'sqs' })) > duplicatesBefore
        ? true
        : undefined,
    );
    await drained();
    expect(await walletState(target.id)).toEqual({ balance: '70.00', transactions: 1 });
  });

  test('a BET sent over HTTP and then over SQS with the same key is a replay (same use case, R-52)', async () => {
    const target = await wallet();
    const { idempotencyKey, ...body } = bet(target);
    const response = await fetch(`${app.url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': String(idempotencyKey) },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const duplicates = () => app.metricValue('wager_duplicates_total', { channel: 'sqs' });
    const processed = () =>
      app.metricValue('wager_transactions_total', { channel: 'sqs', status: 'PROCESSED' });
    const before = { duplicates: await duplicates(), processed: await processed() };

    const messageId = await send({ ...body, idempotencyKey });
    await waitFor(() => inboxRow(messageId));
    await drained();

    expect(await walletState(target.id)).toEqual({ balance: '70.00', transactions: 1 });
    expect(app.logs()).toContainEqual(
      expect.objectContaining({ message: 'sqs message processed', messageId, status: 'PROCESSED' }),
    );
    // A replay over SQS is a duplicate, not a second transaction (S11 review, m6).
    expect(await duplicates()).toBe(before.duplicates + 1);
    expect(await processed()).toBe(before.processed);
  });

  test('an INSUFFICIENT_FUNDS rejection is acked, not retried', async () => {
    const target = await wallet('10.00');
    const retriesBefore = await app.metricValue('retries_total', { source: 'sqs' });
    const data = bet(target);
    const messageId = await send(data);

    await waitFor(() => inboxRow(messageId));
    await drained();

    const [transaction] = await sql`
      select status, failure_code from wager_transactions
       where external_transaction_id = ${data.externalTransactionId as string}`;
    expect(transaction).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await walletState(target.id)).toEqual({ balance: '10.00', transactions: 1 });
    // Acked on its first receive (S9 review, m2).
    expect(await app.metricValue('retries_total', { source: 'sqs' })).toBe(retriesBefore);
  });

  test('an occurredAt with a UTC offset instead of Z is accepted (S9 review, m7)', async () => {
    const target = await wallet();
    const messageId = `msg-${newId()}`;
    const envelope = {
      ...wagerMessage(bet(target), messageId),
      occurredAt: '2026-11-13T15:00:00.000-03:00',
    };
    await queues.sendRaw(JSON.stringify(envelope), { groupId: target.id });

    await waitFor(() => inboxRow(messageId));
    await drained();
    expect(await walletState(target.id)).toEqual({ balance: '70.00', transactions: 1 });
  });

  test('a message for an unknown wallet is acked with its inbox row (L-08)', async () => {
    const before = await app.metricValue('sqs_unknown_wallet_messages_total');
    const data = bet({ id: newId(), playerId: `player-${newId()}` });
    const messageId = await send(data);

    await waitFor(() => inboxRow(messageId));
    await drained();

    const [count] = await sql`
      select count(*)::int as n from wager_transactions
       where external_transaction_id = ${data.externalTransactionId as string}`;
    expect(count).toEqual({ n: 0 });
    expect(await app.metricValue('sqs_unknown_wallet_messages_total')).toBe(before + 1);
  });
});

describe('SQS consumer: transient failures (R-55)', () => {
  test('a wallet locked past the lock timeout is retried and reaches the DLQ after 5 receives, with no effect', async () => {
    const target = await wallet();
    const release = await holdWallet(target.id);
    const retriesBefore = await app.metricValue('retries_total', { source: 'sqs' });
    try {
      const messageId = await send(bet(target));

      const dead = await deadLettered(messageId);
      // Moved by the redrive policy, not by the consumer: no failure reason attribute.
      expect(failureReason(dead)).toBeUndefined();
      expect(
        (await app.metricValue('retries_total', { source: 'sqs' })) - retriesBefore,
      ).toBeGreaterThanOrEqual(5);
      expect(await inboxRow(messageId)).toBeUndefined();
    } finally {
      await release();
    }
    await drained();
    expect(await walletState(target.id)).toEqual({ balance: '100.00', transactions: 0 });
  });

  test('a transient failure that clears is applied once', async () => {
    const target = await wallet();
    const release = await holdWallet(target.id);
    const retriesBefore = await app.metricValue('retries_total', { source: 'sqs' });
    const messageId = await send(bet(target));
    try {
      await waitFor(async () =>
        (await app.metricValue('retries_total', { source: 'sqs' })) >= retriesBefore + 2
          ? true
          : undefined,
      );
    } finally {
      await release();
    }

    await waitFor(() => inboxRow(messageId));
    await drained();
    expect(await walletState(target.id)).toEqual({ balance: '70.00', transactions: 1 });
  });
});

describe('SQS consumer: visibility backoff (R-55, S9 review m4)', () => {
  test('each retry stays invisible twice as long as the previous one, up to the cap', async () => {
    // Its own queue and instance: the suite's instance retries at once.
    const own = await createTestQueues('s9-backoff');
    const slow = await startApp({
      ...own.env,
      SQS_CONSUMER_CONCURRENCY: 1,
      SQS_WAIT_TIME_S: 1,
      SQS_VISIBILITY_TIMEOUT_S: 5,
      SQS_RETRY_BASE_DELAY_S: 1,
      SQS_RETRY_MAX_DELAY_S: 2,
      DATABASE_LOCK_TIMEOUT_MS: 100,
    });
    const target = await wallet();
    const release = await holdWallet(target.id);
    const messageId = `msg-${newId()}`;
    const retries = () =>
      slow
        .logs()
        .filter(
          (line) => line.message === 'sqs message failed, retrying' && line.messageId === messageId,
        );
    try {
      await own.sendRaw(JSON.stringify(wagerMessage(bet(target), messageId)), {
        groupId: target.id,
      });
      await waitFor(async () => (retries().length >= 3 ? true : undefined), 15_000);
      await release();

      expect(
        retries()
          .slice(0, 3)
          .map(({ receiveCount, retryInSeconds }) => ({ receiveCount, retryInSeconds })),
      ).toEqual([
        { receiveCount: 1, retryInSeconds: 1 },
        { receiveCount: 2, retryInSeconds: 2 },
        { receiveCount: 3, retryInSeconds: 2 },
      ]);
      await waitFor(() => inboxRow(messageId), 10_000);
      await waitFor(async () => ((await own.depth(own.url)) === 0 ? true : undefined));
      expect(await walletState(target.id)).toEqual({ balance: '70.00', transactions: 1 });
    } finally {
      await release();
      await slow.close();
      await own.remove();
    }
  });
});

describe('SQS consumer: permanent failures go to the DLQ at once (R-55)', () => {
  test('a message that is not JSON goes to the DLQ on its first receive', async () => {
    const retriesBefore = await app.metricValue('retries_total', { source: 'sqs' });
    const body = `not json ${newId()}`;
    await queues.sendRaw(body, { groupId: `raw-${newId()}` });

    const dead = await deadLettered(body);
    expect(failureReason(dead)).toBe('RequestValidationError');
    expect(await app.metricValue('retries_total', { source: 'sqs' })).toBe(retriesBefore);
  });

  test('an invalid payload goes to the DLQ on its first receive', async () => {
    const target = await wallet();
    const retriesBefore = await app.metricValue('retries_total', { source: 'sqs' });
    const messageId = await send(bet(target, '30.00', { bonus: 'unknown field' }));

    const dead = await deadLettered(messageId);
    expect(failureReason(dead)).toBe('RequestValidationError');
    expect(await app.metricValue('retries_total', { source: 'sqs' })).toBe(retriesBefore);
    expect(await walletState(target.id)).toEqual({ balance: '100.00', transactions: 0 });
  });

  test('the same messageId with another payload goes to the DLQ and leaves the first effect alone', async () => {
    const target = await wallet();
    const data = bet(target);
    const messageId = await send(data);
    await waitFor(() => inboxRow(messageId));

    await send({ ...data, money: { amount: '31.00', currency: 'BRL' } }, messageId);

    const dead = await deadLettered(messageId);
    expect(failureReason(dead)).toBe('InboxMessageConflictError');
    await drained();
    expect(await walletState(target.id)).toEqual({ balance: '70.00', transactions: 1 });
  });

  test('the same messageId with another idempotency key goes to the DLQ (PR #9 review)', async () => {
    const target = await wallet();
    const data = bet(target);
    const messageId = await send(data);
    await waitFor(() => inboxRow(messageId));

    await send({ ...data, idempotencyKey: `other-key-${newId()}` }, messageId);

    const dead = await deadLettered(messageId);
    expect(failureReason(dead)).toBe('InboxMessageConflictError');
    await drained();
    expect(await walletState(target.id)).toEqual({ balance: '70.00', transactions: 1 });
  });

  test('an idempotency key or external id conflict goes to the DLQ (docs/tasks/S9.md Q1)', async () => {
    const target = await wallet();
    const data = bet(target);
    const first = await send(data);
    await waitFor(() => inboxRow(first));

    const sameKey = await send({ ...data, money: { amount: '31.00', currency: 'BRL' } });
    const sameExternalId = await send({ ...data, idempotencyKey: `other-key-${newId()}` });

    expect(failureReason(await deadLettered(sameKey))).toBe('IdempotencyKeyConflictError');
    expect(failureReason(await deadLettered(sameExternalId))).toBe(
      'ExternalTransactionConflictError',
    );
    await drained();
    expect(await walletState(target.id)).toEqual({ balance: '70.00', transactions: 1 });
  });
});
