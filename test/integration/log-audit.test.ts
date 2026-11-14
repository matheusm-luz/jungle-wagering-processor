import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { startApp, type TestApp } from '../support/app';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { newId } from '../support/schema-fixtures';
import { createTestTopic, type TestTopic } from '../support/topics';

setDefaultTimeout(60_000);

let app: TestApp;
let sql: SQL;
let queues: TestQueues;
let topic: TestTopic;

const PROVIDER = `provider-s11-audit-${newId().slice(0, 8)}`;

/**
 * Every amount this file sends, and the balances they lead to. None of them is round, so a match
 * in a log line is a leak, not a coincidence.
 */
const OPENING = '4321.87';
const AMOUNTS = {
  bet: '73.19',
  overdraw: '98765.43',
  conflicting: '61.07',
  invalid: '12.345',
  unknownWallet: '55.56',
  waiting: '33.37',
  failed: '44.48',
  sqs: '22.29',
  sqsInvalid: '7.777',
  unreadable: '88.89',
  sqsRetried: '19.73',
  sqsUnknownWallet: '27.41',
};
const BALANCES = ['4248.68', '4215.31', '4226.39', '4206.66'];
const FORBIDDEN_VALUES = [OPENING, ...Object.values(AMOUNTS), ...BALANCES];
/** Keys of a financial payload: a log line carries counts and identifiers, never these. */
const FORBIDDEN_KEYS = ['money', 'amount', 'balance', 'initialBalance', 'body', 'payload', 'data'];

beforeAll(async () => {
  sql = await migratedDatabase();
  queues = await createTestQueues('s11-audit');
  topic = await createTestTopic('s11-audit');
  // Rows other suites left unpublished are not this file's events (S10).
  await sql`update outbox_messages set published_at = now() where published_at is null`;
  app = await startApp({
    ...queues.env,
    ...topic.env,
    SQS_CONSUMER_CONCURRENCY: 1,
    SQS_WAIT_TIME_S: 1,
    SQS_RETRY_BASE_DELAY_S: 0,
    SQS_RETRY_MAX_DELAY_S: 0,
    OUTBOX_POLL_INTERVAL_MS: 20,
    PENDING_REFERENCE_BASE_DELAY_MS: 50,
    PENDING_REFERENCE_MAX_DELAY_MS: 200,
    PENDING_REFERENCE_MAX_ATTEMPTS: 50,
    PENDING_REFERENCE_POLL_INTERVAL_MS: 20,
    DATABASE_LOCK_TIMEOUT_MS: 200,
  });
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await app.close();
  await queues.remove();
  await topic.remove();
  await sql.close();
});

interface Wallet {
  id: string;
  playerId: string;
}

type Body = Record<string, unknown>;

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

async function submit(body: Body, key = `${body.providerId}:${body.externalTransactionId}`) {
  const response = await fetch(`${app.url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  return { status: response.status, result: (await response.json()) as Body };
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}

async function statusOf(externalTransactionId: unknown) {
  const [row] = await sql`
    select status from wager_transactions where external_transaction_id = ${String(externalTransactionId)}`;
  return row?.status as string | undefined;
}

describe('log audit (R-60, statement §12)', () => {
  // Not driven here: the publisher's failures, the reconciliation divergence and a failed metric
  // read. Their lines carry error names and counts only (S11 review, m4).
  test('the HTTP, SQS, worker and publisher paths it drives log no amount and no financial payload', async () => {
    const opened = await fetch(`${app.url}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: `player-${newId()}`,
        initialBalance: { amount: OPENING, currency: 'BRL' },
      }),
    });
    expect(opened.status).toBe(201);
    const wallet = (await opened.json()) as Wallet;

    // HTTP: processed, rejected, replay, key conflict, invalid body, unknown wallet.
    const bet = wager(wallet, 'BET', AMOUNTS.bet);
    expect((await submit(bet)).status).toBe(200);
    expect((await submit(wager(wallet, 'BET', AMOUNTS.overdraw))).status).toBe(422);
    expect((await submit(bet)).status).toBe(200);
    const conflicting = { ...bet, money: { amount: AMOUNTS.conflicting, currency: 'BRL' } };
    expect((await submit(conflicting)).status).toBe(409);
    expect((await submit(wager(wallet, 'BET', AMOUNTS.invalid))).status).toBe(400);
    const stranger = { id: newId(), playerId: `player-${newId()}` };
    expect((await submit(wager(stranger, 'BET', AMOUNTS.unknownWallet))).status).toBe(404);

    // Worker: a REFUND that waits for its BET, then is resolved.
    const waitingBet = wager(wallet, 'BET', AMOUNTS.waiting);
    const refund = wager(wallet, 'REFUND', AMOUNTS.waiting, {
      referenceExternalTransactionId: waitingBet.externalTransactionId,
    });
    expect((await submit(refund)).status).toBe(202);
    expect((await submit(waitingBet)).status).toBe(200);
    await waitFor(async () =>
      (await statusOf(refund.externalTransactionId)) === 'PROCESSED' ? true : undefined,
    );

    // An unexpected error: the provider's settlement account is held, so the ledger insert's
    // foreign-key check waits past the lock timeout and the request fails with a 500.
    const failed = await sql.begin(async (tx) => {
      await tx`select id from ledger_accounts where provider_id = ${PROVIDER} for update`;
      return submit(wager(wallet, 'BET', AMOUNTS.failed));
    });
    expect(failed.status).toBe(500);

    // Reads.
    const id = String((await submit(bet)).result.transactionId);
    for (const path of [
      `/wagering/transactions/${id}`,
      `/providers/${PROVIDER}/wagering/transactions/${bet.externalTransactionId}`,
      `/wallets/${wallet.id}`,
      `/wallets/${wallet.id}/ledger`,
    ]) {
      expect((await fetch(`${app.url}${path}`)).status).toBe(200);
    }

    // SQS: processed, dead-lettered for an invalid payload, dead-lettered unreadable.
    const message = wager(wallet, 'BET', AMOUNTS.sqs);
    const send = (data: Body) =>
      queues.sendRaw(
        JSON.stringify(
          wagerMessage(
            { ...data, idempotencyKey: `${PROVIDER}:${data.externalTransactionId}` },
            `msg-${newId()}`,
          ),
        ),
        { groupId: wallet.id },
      );
    await send(message);
    await send(wager(wallet, 'BET', AMOUNTS.sqsInvalid));
    await queues.sendRaw(`{"money":{"amount":"${AMOUNTS.unreadable}"`, { groupId: wallet.id });
    await waitFor(async () =>
      (await statusOf(message.externalTransactionId)) === 'PROCESSED' ? true : undefined,
    );
    await waitFor(async () => ((await queues.depth(queues.url)) === 0 ? true : undefined));

    // SQS: a message for an unknown wallet, and a transient failure (the wallet held past the lock
    // timeout) retried until the wallet is released.
    const stranger2 = { id: newId(), playerId: `player-${newId()}` };
    await queues.sendRaw(
      JSON.stringify(
        wagerMessage(
          {
            ...wager(stranger2, 'BET', AMOUNTS.sqsUnknownWallet),
            idempotencyKey: `${PROVIDER}:${newId()}`,
          },
          `msg-${newId()}`,
        ),
      ),
      { groupId: stranger2.id },
    );
    const retried = wager(wallet, 'BET', AMOUNTS.sqsRetried);
    await sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${wallet.id} for update`;
      await send(retried);
      await waitFor(async () =>
        app.logs().some((line) => line.message === 'sqs message failed, retrying')
          ? true
          : undefined,
      );
    });
    await waitFor(async () =>
      (await statusOf(retried.externalTransactionId)) === 'PROCESSED' ? true : undefined,
    );
    await waitFor(async () => ((await queues.depth(queues.url)) === 0 ? true : undefined));

    // Publisher: every event of the wallet reaches the topic.
    await waitFor(async () => {
      const [row] = await sql`
        select count(*)::int as pending from outbox_messages
         where aggregate_id = ${wallet.id} and published_at is null`;
      return row?.pending === 0 ? true : undefined;
    });

    const lines = app.logs();
    const messages = new Set(lines.map((line) => line.message));
    // The audit saw every path it claims to cover.
    for (const expected of [
      'http request',
      'sqs message processed',
      'sqs message dead-lettered',
      'sqs message failed, retrying',
      'sqs message for an unknown wallet',
      'pending reference retried',
      'outbox batch published',
    ]) {
      expect(messages).toContain(expected);
    }
    expect(lines.some((line) => line.level === 'error' && line.correlationId !== undefined)).toBe(
      true,
    );

    for (const line of lines) {
      const text = JSON.stringify(line);
      for (const value of FORBIDDEN_VALUES) {
        if (text.includes(value)) throw new Error(`log line carries ${value}: ${text}`);
      }
      const key = forbiddenKey(line);
      if (key !== undefined) throw new Error(`log line has a ${key} field: ${text}`);
    }
    for (const line of lines.filter((line) => line.message === 'http request')) {
      expect(line.correlationId).toBeString();
    }
  });
});

/** The first forbidden key at any depth: the logger takes flat fields, but a nested one would hide. */
function forbiddenKey(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) return key;
    const found = forbiddenKey(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}
