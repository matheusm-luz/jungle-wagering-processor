import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startProcesses } from '../support/processes';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { newId, seedWallet } from '../support/schema-fixtures';

setDefaultTimeout(90_000);

let sql: SQL;
let queues: TestQueues;

beforeAll(async () => {
  sql = await migratedDatabase();
  queues = await createTestQueues('s9-processes');
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await queues.remove();
  await sql.close();
});

const PROVIDER = 'provider-s9';

/** Every process consumes this test file's own queue; retries come back at once. */
const consumerEnv = (overrides: Record<string, string> = {}) => ({
  ...queues.env,
  SQS_WAIT_TIME_S: '1',
  SQS_RETRY_BASE_DELAY_S: '0',
  SQS_RETRY_MAX_DELAY_S: '0',
  ...overrides,
});

async function wallet(balance = '100.00') {
  const { wallet: row } = await seedWallet(sql, balance);
  return { id: row.id as string, playerId: row.player_id as string };
}

async function sendBet(
  target: { id: string; playerId: string },
  externalTransactionId = `tx-${newId()}`,
  messageId = `msg-${newId()}`,
): Promise<string> {
  const data = {
    providerId: PROVIDER,
    externalTransactionId,
    idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
    playerId: target.playerId,
    walletId: target.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };
  await queues.sendRaw(JSON.stringify(wagerMessage(data, messageId)), { groupId: target.id });
  return messageId;
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}

const drained = (url = queues.url) =>
  waitFor(async () => ((await queues.depth(url)) === 0 ? true : undefined));

async function walletState(walletId: string) {
  const [row] = await sql`
    select w.balance, w.version,
           (select count(*)::int from wager_transactions t
             where t.wallet_id = w.id and t.kind <> 'OPENING') as transactions
      from wallets w where w.id = ${walletId}`;
  return row;
}

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

/** True once some session waits for a row lock: the consumer is in flight on the held wallet. */
const someoneWaitsForALock = () =>
  waitFor(async () => {
    const [row] = await sql`
      select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`;
    return (row?.n as number) > 0 ? true : undefined;
  });

describe('SQS consumer across processes', () => {
  test('a process killed after commit and before ack: the redelivery is acked by another process with no second effect (R-68)', async () => {
    const target = await wallet();
    const crashing = await startProcesses(
      1,
      consumerEnv({ SQS_CONSUMER_FAILPOINT: 'crash-after-commit', SQS_VISIBILITY_TIMEOUT_S: '2' }),
    );
    const messageId = await sendBet(target);

    await crashing.exited[0];
    // Committed, never acknowledged: the effect is there and the message is still in the queue.
    const [inbox] =
      await sql`select count(*)::int as n from inbox_messages where message_id = ${messageId}`;
    expect(inbox).toEqual({ n: 1 });
    expect(await walletState(target.id)).toEqual({ balance: '90.00', version: 2, transactions: 1 });
    expect(await queues.depth(queues.url)).toBe(1);

    const survivor = await startProcesses(1, consumerEnv());
    try {
      await drained();
    } finally {
      await survivor.stop();
    }
    expect(await walletState(target.id)).toEqual({ balance: '90.00', version: 2, transactions: 1 });
    expect(await queues.depth(queues.dlqUrl)).toBe(0);
  });

  test('SIGTERM with a message in flight finishes it, acks it and exits (R-56)', async () => {
    const target = await wallet();
    const app = await startProcesses(
      1,
      consumerEnv({
        SQS_SHUTDOWN_GRACE_MS: '10000',
        SQS_VISIBILITY_TIMEOUT_S: '60',
        DATABASE_LOCK_TIMEOUT_MS: '20000',
      }),
    );
    const release = await holdWallet(target.id);
    try {
      await sendBet(target);
      await someoneWaitsForALock();
      process.kill(app.pids[0] as number, 'SIGTERM');
      await Bun.sleep(300);
    } finally {
      await release();
    }
    await app.exited[0];

    expect(await queues.depth(queues.url)).toBe(0);
    expect(await walletState(target.id)).toEqual({ balance: '90.00', version: 2, transactions: 1 });
  });

  test('SIGTERM with a message stuck past the grace period returns its visibility: it is received again long before its visibility timeout, and applied once (R-56)', async () => {
    const target = await wallet();
    const app = await startProcesses(
      1,
      consumerEnv({
        SQS_SHUTDOWN_GRACE_MS: '300',
        SQS_VISIBILITY_TIMEOUT_S: '60',
        DATABASE_LOCK_TIMEOUT_MS: '3000',
      }),
    );
    const release = await holdWallet(target.id);
    let seenAfterMs: number;
    try {
      const messageId = await sendBet(target);
      await someoneWaitsForALock();
      const signalled = performance.now();
      process.kill(app.pids[0] as number, 'SIGTERM');

      // Visible again although its 60 s visibility timeout is far from over.
      const [again] = await waitFor(async () => {
        const messages = await queues.peek(queues.url, 1000);
        return messages.some((message) => message.Body?.includes(messageId)) ? messages : undefined;
      }, 10_000);
      seenAfterMs = performance.now() - signalled;
      expect(again).toBeDefined();
    } finally {
      await release();
    }
    expect(seenAfterMs).toBeLessThan(10_000);
    await app.exited[0];

    const next = await startProcesses(1, consumerEnv());
    try {
      await drained();
    } finally {
      await next.stop();
    }
    expect(await walletState(target.id)).toEqual({ balance: '90.00', version: 2, transactions: 1 });
    expect(await queues.depth(queues.dlqUrl)).toBe(0);
  });

  test('three processes consume one queue: every message applied once, in group order', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => wallet()));
    const apps = await startProcesses(3, consumerEnv());
    const sent = new Map<string, string[]>();
    try {
      // Within a wallet in order, each message twice in a row; wallets in parallel.
      await Promise.all(
        wallets.map(async (target) => {
          const ids: string[] = [];
          for (let i = 0; i < 5; i++) {
            const externalId = `tx-${i}-${newId()}`;
            const messageId = `msg-${newId()}`;
            await sendBet(target, externalId, messageId);
            await sendBet(target, externalId, messageId);
            ids.push(externalId);
          }
          sent.set(target.id, ids);
        }),
      );
      await drained();
    } finally {
      await apps.stop();
    }

    for (const target of wallets) {
      expect(await walletState(target.id)).toEqual({
        balance: '50.00',
        version: 6,
        transactions: 5,
      });
      const applied = await sql`
        select t.external_transaction_id as id from wallet_ledger_entries e
          join wager_transactions t on t.id = e.transaction_id
         where e.wallet_id = ${target.id} and t.kind = 'BET'
         order by e.sequence`;
      expect(applied.map((row: { id: string }) => row.id)).toEqual(sent.get(target.id));
    }
    expect(await queues.depth(queues.dlqUrl)).toBe(0);
  });
});
