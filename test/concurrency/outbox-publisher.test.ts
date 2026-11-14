import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startProcesses } from '../support/processes';
import { createTestQueues, type TestQueues, wagerMessage } from '../support/queues';
import { newId } from '../support/schema-fixtures';
import { createTestTopic, type ReceivedEvent, type TestTopic } from '../support/topics';

setDefaultTimeout(120_000);

let sql: SQL;
let topic: TestTopic;
let queues: TestQueues;

beforeAll(async () => {
  sql = await migratedDatabase();
  topic = await createTestTopic('s10-processes');
  queues = await createTestQueues('s10-processes');
  // Rows other suites left unpublished in the shared database are not this file's events.
  await sql`update outbox_messages set published_at = now() where published_at is null`;
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await topic.remove();
  await queues.remove();
  await sql.close();
});

const PROVIDER = 'provider-s10';

/** Every process publishes to this file's topic; the test container idles the publisher otherwise. */
const publisherEnv = (overrides: Record<string, string> = {}) => ({
  ...topic.env,
  OUTBOX_POLL_INTERVAL_MS: '50',
  ...overrides,
});

interface Wallet {
  id: string;
  playerId: string;
}

async function openWallet(url: string): Promise<Wallet> {
  const response = await fetch(`${url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: `player-${newId()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Wallet;
}

function betData(wallet: Wallet) {
  const externalTransactionId = `tx-${newId()}`;
  return {
    providerId: PROVIDER,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  };
}

async function betOverHttp(url: string, wallet: Wallet): Promise<void> {
  const data = betData(wallet);
  const response = await fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': data.externalTransactionId },
    body: JSON.stringify(data),
  });
  expect(response.status).toBe(200);
}

async function betOverSqs(wallet: Wallet): Promise<void> {
  const data = betData(wallet);
  const message = wagerMessage({ ...data, idempotencyKey: data.externalTransactionId });
  await queues.sendRaw(JSON.stringify(message), { groupId: wallet.id });
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}

/** The outbox rows of `walletIds`, with whether each one is published. */
async function outboxOf(walletIds: string[]) {
  return (await sql`
    select id, published_at is not null as published from outbox_messages
     where aggregate_id in ${sql(walletIds)}`) as { id: string; published: boolean }[];
}

const allPublished = (walletIds: string[]) =>
  waitFor(async () => {
    const rows = await outboxOf(walletIds);
    return rows.every((row) => row.published) ? rows : undefined;
  });

const ids = (events: ReceivedEvent[]) => events.map((event) => event.body.eventId).sort();

/** Two processes: one commits events over HTTP with its publisher idle, one stays to be killed. */
async function committedEvents(): Promise<{ wallet: Wallet; rows: { id: string }[] }> {
  const committer = await startProcesses(1);
  try {
    const wallet = await openWallet(committer.urls[0] as string);
    await betOverHttp(committer.urls[0] as string, wallet);
    // Statement §11 step 2: the instance that committed dies before anything is published.
    process.kill(committer.pids[0] as number, 'SIGKILL');
    await committer.exited[0];
    const rows = await outboxOf([wallet.id]);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => !row.published)).toBe(true);
    return { wallet, rows };
  } catch (error) {
    await committer.stop();
    throw error;
  }
}

describe('outbox publisher across processes', () => {
  test('committed, then the process dies; a publisher killed with the batch locked publishes nothing; another process publishes every event once (statement §11, R-57)', async () => {
    const { wallet, rows } = await committedEvents();

    // First poll after 1.5 s, so the harness sees the process ready before the failpoint kills it.
    const crashing = await startProcesses(
      1,
      publisherEnv({
        OUTBOX_POLL_INTERVAL_MS: '1500',
        OUTBOX_PUBLISHER_FAILPOINT: 'crash-before-publish',
      }),
    );
    await crashing.exited[0];
    expect((await outboxOf([wallet.id])).every((row) => !row.published)).toBe(true);
    // Its locks went with its connection: the rows can be locked again at once.
    const [lockable] = await sql`
      select count(*)::int as n from (select id from outbox_messages
       where aggregate_id = ${wallet.id} for update skip locked) locked`;
    expect(lockable).toEqual({ n: 4 });

    const survivor = await startProcesses(1, publisherEnv());
    try {
      await allPublished([wallet.id]);
    } finally {
      await survivor.stop();
    }
    const received = await topic.collect((all) => all.length >= 4);
    expect(ids(received)).toEqual(rows.map((row) => row.id).sort());
    expect(await topic.collect(() => false, 1500)).toEqual([]);
  });

  test('a process killed after publishing and before marking: another process publishes again under the same eventId and the subscriber gets one copy (statement §11)', async () => {
    const { wallet, rows } = await committedEvents();

    const crashing = await startProcesses(
      1,
      publisherEnv({
        OUTBOX_POLL_INTERVAL_MS: '1500',
        OUTBOX_PUBLISHER_FAILPOINT: 'crash-after-publish',
      }),
    );
    await crashing.exited[0];
    // Published, never recorded as published.
    const first = await topic.collect((all) => all.length >= 4);
    expect(ids(first)).toEqual(rows.map((row) => row.id).sort());
    expect((await outboxOf([wallet.id])).every((row) => !row.published)).toBe(true);

    const survivor = await startProcesses(1, publisherEnv());
    try {
      await allPublished([wallet.id]);
    } finally {
      await survivor.stop();
    }
    // The second publication carried the same event ids; the broker dropped every copy.
    expect(await topic.collect(() => false, 2000)).toEqual([]);
    expect(first.every((event) => event.dedupId === event.body.eventId)).toBe(true);
  });

  test('three publishers drain one outbox: every event published once, none lost (R-69)', async () => {
    const apps = await startProcesses(3, publisherEnv());
    let walletIds: string[] = [];
    try {
      // 30 wallets, each opened and bet on five times, spread over the three processes.
      const wallets = await Promise.all(
        Array.from({ length: 30 }, async (_, i) => {
          const wallet = await openWallet(apps.urls[i % 3] as string);
          for (let bet = 0; bet < 5; bet++) {
            await betOverHttp(apps.urls[(i + bet) % 3] as string, wallet);
          }
          return wallet;
        }),
      );
      walletIds = wallets.map((wallet) => wallet.id);
      await allPublished(walletIds);
    } finally {
      await apps.stop();
    }

    const rows = await outboxOf(walletIds);
    expect(rows).toHaveLength(30 * 12);
    const received = await topic.collect((all) => all.length >= rows.length);
    expect(ids(received)).toEqual(rows.map((row) => row.id).sort());
    expect(await topic.collect(() => false, 1500)).toEqual([]);
  });

  test('a process killed under HTTP and SQS load and replaced: the queue drains, the outbox empties, every wallet ends consistent (R-71)', async () => {
    const env = publisherEnv({
      ...queues.env,
      SQS_WAIT_TIME_S: '1',
      SQS_VISIBILITY_TIMEOUT_S: '2',
      SQS_RETRY_BASE_DELAY_S: '0',
      SQS_RETRY_MAX_DELAY_S: '0',
    });
    const doomed = await startProcesses(1, env);
    const others = await startProcesses(2, env);
    const urls = [doomed.urls[0], ...others.urls] as string[];
    let replacement: Awaited<ReturnType<typeof startProcesses>> | undefined;
    let wallets: Wallet[] = [];
    try {
      wallets = await Promise.all(
        Array.from({ length: 20 }, (_, i) => openWallet(urls[i % 3] as string)),
      );
      // Five bets per wallet: three over SQS, two over HTTP to the survivors.
      const load = Promise.all(
        wallets.map(async (wallet, i) => {
          for (let bet = 0; bet < 3; bet++) await betOverSqs(wallet);
          for (let bet = 0; bet < 2; bet++) {
            await betOverHttp(others.urls[(i + bet) % 2] as string, wallet);
          }
        }),
      );
      // Mid-load: some messages are in flight on the doomed process, some events unpublished.
      await waitFor(async () => {
        const [row] = await sql`
          select count(*)::int as n from wager_transactions
           where wallet_id in ${sql(wallets.map((wallet) => wallet.id))} and kind = 'BET'`;
        return (row?.n as number) >= 10 ? true : undefined;
      });
      process.kill(doomed.pids[0] as number, 'SIGKILL');
      await doomed.exited[0];
      replacement = await startProcesses(1, env);
      await load;

      await waitFor(async () => ((await queues.depth(queues.url)) === 0 ? true : undefined));
      await allPublished(wallets.map((wallet) => wallet.id));
    } finally {
      await others.stop();
      await replacement?.stop();
    }

    for (const wallet of wallets) {
      const [state] = await sql`
        select w.balance, w.version,
               (select count(*)::int from wager_transactions t
                 where t.wallet_id = w.id and t.kind = 'BET') as bets
          from wallets w where w.id = ${wallet.id}`;
      expect(state).toEqual({ balance: '50.00', version: 6, bets: 5 });
    }
    expect(await queues.depth(queues.dlqUrl)).toBe(0);
    const rows = await outboxOf(wallets.map((wallet) => wallet.id));
    expect(rows).toHaveLength(20 * 12);
    const received = await topic.collect((all) => all.length >= rows.length);
    expect(ids(received)).toEqual(rows.map((row) => row.id).sort());
  });
});
