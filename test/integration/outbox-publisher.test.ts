import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import type { Clock } from '../../src/application/ports';
import type { Env } from '../../src/config/env';
import { JsonLogger } from '../../src/infrastructure/logging/json-logger';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox.publisher';
import { createSnsClient } from '../../src/infrastructure/messaging/sns.provider';
import { Metrics } from '../../src/infrastructure/metrics/metrics';
import { startApp, type TestApp } from '../support/app';
import { inRolledBackTransaction, migratedDatabase, testEnv } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startOrm } from '../support/orm';
import { newId } from '../support/schema-fixtures';
import { createTestTopic, type ReceivedEvent, type TestTopic } from '../support/topics';

setDefaultTimeout(30_000);

let sql: SQL;
let orm: MikroORM;
let app: TestApp;
let topic: TestTopic;
const sns = createSnsClient(testEnv);

beforeAll(async () => {
  sql = await migratedDatabase();
  orm = await startOrm();
  // The HTTP side only: its publisher idles (the test container's setting), so each test drives one.
  app = await startApp();
  topic = await createTestTopic('s10');
  // Rows other suites left unpublished in the shared database are not this file's events; a
  // publisher here would otherwise spend the file draining them.
  await sql`update outbox_messages set published_at = now() where published_at is null`;
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await app.close();
  await orm.close();
  await topic.remove();
  sns.destroy();
  await sql.close();
});

const PROVIDER = 'provider-s10';
const realClock: Clock = { now: () => new Date() };

function publisher(overrides: Partial<Env> = {}, clock: Clock = realClock) {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger({
    level: 'debug',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const env: Env = { ...testEnv, ...topic.env, ...overrides };
  return { publisher: new OutboxPublisher(orm, sns, env, clock, logger, new Metrics()), lines };
}

interface Wallet {
  id: string;
  playerId: string;
}

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

async function bet(wallet: Wallet, amount = '10.00') {
  const externalTransactionId = `tx-${newId()}`;
  const response = await fetch(`${app.url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': externalTransactionId },
    body: JSON.stringify({
      providerId: PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(200);
}

interface Row {
  id: string;
  event_type: string;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

/** The wallet's outbox rows in the order the publisher takes them. */
async function rowsOf(walletId: string): Promise<Row[]> {
  return await sql`
    select id, event_type, attempts, next_attempt_at, published_at from outbox_messages
     where aggregate_id = ${walletId} order by next_attempt_at, id`;
}

/** A wallet opened with a balance and one bet: four events (two per transaction). */
async function walletWithEvents(): Promise<{ wallet: Wallet; rows: Row[] }> {
  const wallet = await openWallet();
  await bet(wallet);
  const rows = await rowsOf(wallet.id);
  expect(rows).toHaveLength(4);
  return { wallet, rows };
}

const eventIds = (events: ReceivedEvent[]) => events.map((event) => event.body.eventId);

/** Runs `lock` in an open transaction until the returned release is called. */
async function holdInTransaction(
  lock: (tx: SQL) => Promise<unknown>,
): Promise<() => Promise<void>> {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked = () => {};
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = sql.begin(async (tx) => {
    await lock(tx);
    locked();
    await held;
  });
  await isLocked;
  return async () => {
    release();
    await holder;
  };
}

/** True once some session waits for a lock. */
async function someoneWaitsForALock(): Promise<void> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const [row] = await sql`
      select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`;
    if ((row?.n as number) > 0) return;
    if (performance.now() > deadline) throw new Error('nobody waits for a lock');
    await Bun.sleep(20);
  }
}

describe('outbox publisher', () => {
  test("a committed BET's events reach the topic in order, with the wallet as group and the event id as deduplication id, and are marked published (R-08, ADR-11)", async () => {
    const { wallet, rows } = await walletWithEvents();

    expect(await publisher().publisher.publishDue()).toEqual({ published: 4, failed: 0 });

    const received = await topic.collect((all) => all.length >= 4);
    expect(eventIds(received)).toEqual(rows.map((row) => row.id));
    for (const [i, event] of received.entries()) {
      expect(event.groupId).toBe(wallet.id);
      expect(event.dedupId).toBe(event.body.eventId);
      expect(event.eventType).toBe(rows[i]?.event_type);
      expect(event.body).toMatchObject({ eventType: rows[i]?.event_type, aggregateId: wallet.id });
    }
    const after = await rowsOf(wallet.id);
    expect(after.every((row) => row.published_at !== null && row.attempts === 0)).toBe(true);
  });

  test('an event is never published before its transaction commits (R-08)', async () => {
    const id = newId();
    const walletId = newId();
    await inRolledBackTransaction(sql, async (tx) => {
      await tx`
        insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
        values (${id}, ${walletId}, 'WalletBalanceChanged', ${JSON.stringify({ eventId: id })}::jsonb, now(), now())`;
      // Uncommitted: invisible to the publisher's own transaction.
      expect(await publisher().publisher.publishDue()).toEqual({ published: 0, failed: 0 });
    });

    expect(await topic.collect(() => false, 1500)).toEqual([]);
    expect(await rowsOf(walletId)).toEqual([]);
  });
  test('rows locked by another publisher are skipped, and published once released (ADR-04)', async () => {
    const { rows } = await walletWithEvents();
    const held = rows.slice(0, 2).map((row) => row.id);
    const release = await holdInTransaction(
      (tx) => tx`select id from outbox_messages where id in ${tx(held)} for update`,
    );
    try {
      // Does not wait for the held rows: it publishes the other two at once.
      expect(await publisher().publisher.publishDue()).toEqual({ published: 2, failed: 0 });
    } finally {
      await release();
    }
    expect(await publisher().publisher.publishDue()).toEqual({ published: 2, failed: 0 });

    const received = await topic.collect((all) => all.length >= 4);
    expect(eventIds(received).sort()).toEqual(rows.map((row) => row.id).sort());
  });

  test('a publish to a missing topic counts attempts with a growing delay and keeps the event; a publisher with the right topic then publishes it (ADR-04)', async () => {
    const { wallet, rows } = await walletWithEvents();
    let now = new Date();
    const clock: Clock = { now: () => now };
    const broken = publisher(
      {
        WAGER_EVENTS_TOPIC_ARN: `${topic.env.WAGER_EVENTS_TOPIC_ARN}-missing`,
        OUTBOX_RETRY_BASE_DELAY_MS: 1000,
        OUTBOX_RETRY_MAX_DELAY_MS: 3000,
      },
      clock,
    );

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await broken.publisher.publishDue()).toEqual({ published: 0, failed: 4 });
      const after = await rowsOf(wallet.id);
      expect(after.map((row) => row.attempts)).toEqual([attempt, attempt, attempt, attempt]);
      expect(after.every((row) => row.published_at === null)).toBe(true);
      const next = after[0]?.next_attempt_at as Date;
      delays.push(next.getTime() - now.getTime());
      // Not due before its delay.
      now = new Date(next.getTime() - 1);
      expect(await broken.publisher.publishDue()).toEqual({ published: 0, failed: 0 });
      now = next;
    }
    expect(delays).toEqual([1000, 2000, 3000, 3000]);
    expect(broken.lines.some((line) => line.message === 'outbox publish failed')).toBe(true);

    expect(await publisher({}, clock).publisher.publishDue()).toEqual({ published: 4, failed: 0 });
    const received = await topic.collect((all) => all.length >= 4);
    expect(eventIds(received)).toEqual(rows.map((row) => row.id));
  });

  test('a broker that accepts the connection and never answers is abandoned after the publish timeout: the rows are rescheduled, not held (S10 review, m2)', async () => {
    // A network that hangs, not a fake broker: nothing is ever answered on this socket.
    const silent = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => {}, open: () => {} },
    });
    const hanging = createSnsClient({
      ...testEnv,
      AWS_ENDPOINT_URL: `http://127.0.0.1:${silent.port}`,
    });
    const { wallet, rows } = await walletWithEvents();
    let now = new Date();
    const clock: Clock = { now: () => now };
    try {
      const env: Env = { ...testEnv, ...topic.env, OUTBOX_PUBLISH_TIMEOUT_MS: 500 };
      const stuck = new OutboxPublisher(
        orm,
        hanging,
        env,
        clock,
        new JsonLogger({ level: 'silent', write: () => {} }),
        new Metrics(),
      );
      const started = performance.now();
      expect(await stuck.publishDue()).toEqual({ published: 0, failed: 4 });
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      hanging.destroy();
      silent.stop(true);
    }
    const after = await rowsOf(wallet.id);
    expect(after.map((row) => [row.attempts, row.published_at])).toEqual([
      [1, null],
      [1, null],
      [1, null],
      [1, null],
    ]);

    now = after[0]?.next_attempt_at as Date;
    expect(await publisher({}, clock).publisher.publishDue()).toEqual({ published: 4, failed: 0 });
    expect(eventIds(await topic.collect((all) => all.length >= 4))).toEqual(
      rows.map((row) => row.id),
    );
  });

  // The one forged broker answer of the suites (docs/spec/REQUIREMENTS.md, E-8): LocalStack 4.12 never
  // answers a PublishBatch in part (an empty attribute or an oversized entry fails the whole call),
  // so this is the only way to prove that a refused entry is not marked published. The database and
  // the SDK are real; only the HTTP answer is written here, in the documented PublishBatch shape.
  test('a batch the broker accepts in part: only the accepted entries are marked published, the refused ones are rescheduled (S10 PR review)', async () => {
    const { wallet, rows } = await walletWithEvents();
    const accepted = new Set(rows.slice(0, 2).map((row) => row.id));
    const isRefused = (id: string) => !accepted.has(id);
    const partial = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const form = new URLSearchParams(await request.text());
        const ids = [...form.entries()]
          .filter(([key]) => /^PublishBatchRequestEntries\.member\.\d+\.Id$/.test(key))
          .map(([, id]) => id);
        const successful = ids
          .filter((id) => accepted.has(id))
          .map(
            (id) =>
              `<member><Id>${id}</Id><MessageId>m-${id}</MessageId><SequenceNumber>1</SequenceNumber></member>`,
          );
        const failed = ids
          .filter(isRefused)
          .map(
            (id) =>
              `<member><Id>${id}</Id><Code>InternalError</Code><Message>refused</Message><SenderFault>false</SenderFault></member>`,
          );
        const body = `<PublishBatchResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">
          <PublishBatchResult>
            <Successful>${successful.join('')}</Successful>
            <Failed>${failed.join('')}</Failed>
          </PublishBatchResult>
          <ResponseMetadata><RequestId>forged</RequestId></ResponseMetadata>
        </PublishBatchResponse>`;
        return new Response(body, { headers: { 'content-type': 'text/xml' } });
      },
    });
    const forged = createSnsClient({
      ...testEnv,
      AWS_ENDPOINT_URL: `http://127.0.0.1:${partial.port}`,
    });
    let now = new Date();
    const clock: Clock = { now: () => now };
    const lines: Record<string, unknown>[] = [];
    const logger = new JsonLogger({
      level: 'debug',
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    try {
      const env: Env = { ...testEnv, ...topic.env };
      expect(
        await new OutboxPublisher(orm, forged, env, clock, logger, new Metrics()).publishDue(),
      ).toEqual({
        published: 2,
        failed: 2,
      });
    } finally {
      forged.destroy();
      partial.stop(true);
    }

    const after = await rowsOf(wallet.id);
    expect(after.map((row) => [row.id, row.attempts, row.published_at !== null])).toEqual(
      rows.map((row) => [row.id, accepted.has(row.id) ? 0 : 1, accepted.has(row.id)]),
    );
    const refusedIds = rows
      .map((row) => row.id)
      .filter(isRefused)
      .sort();
    const logged = lines.filter((line) => line.message === 'outbox event not published');
    expect(logged.map((line) => String(line.eventId)).sort()).toEqual(refusedIds);

    // The refused entries go out on their next attempt, to the real topic.
    now = after.find((row) => isRefused(row.id))?.next_attempt_at as Date;
    expect(await publisher({}, clock).publisher.publishDue()).toEqual({ published: 2, failed: 0 });
    const received = await topic.collect((all) => all.length >= 2);
    expect(eventIds(received).sort()).toEqual(refusedIds);
  });

  test('a duplicated publication carries the same eventId: the subscriber receives one copy (statement §11)', async () => {
    const { rows } = await walletWithEvents();
    const ids = rows.map((row) => row.id);
    expect(await publisher().publisher.publishDue()).toEqual({ published: 4, failed: 0 });
    const first = await topic.collect((all) => all.length >= 4);

    // The commit that recorded the publication was lost: the rows go out again.
    await sql`update outbox_messages set published_at = null where id in ${sql(ids)}`;
    expect(await publisher().publisher.publishDue()).toEqual({ published: 4, failed: 0 });

    const again = await topic.collect(() => false, 2000);
    expect(again).toEqual([]);
    expect(eventIds(first)).toEqual(ids);
    expect(first.every((event) => event.dedupId === event.body.eventId)).toBe(true);
  });

  test('on close, the batch in flight is finished before the application stops', async () => {
    const { wallet, rows } = await walletWithEvents();
    // The publisher's scan waits behind this lock, so its batch is in flight when close starts.
    const release = await holdInTransaction(
      (tx) => tx`lock table outbox_messages in exclusive mode`,
    );
    const running = await startApp({
      ...topic.env,
      OUTBOX_POLL_INTERVAL_MS: 20,
      DATABASE_LOCK_TIMEOUT_MS: 20_000,
    });
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await someoneWaitsForALock();
      closing = running.close().then(() => {
        closed = true;
      });
      // Longer than the SQS consumer's own shutdown (its open long poll, SQS_WAIT_TIME_S=1), so the
      // publisher's hook runs while its batch still waits; a hook that did not await it would log
      // "stopped" first.
      await Bun.sleep(2000);
      expect(closed).toBe(false);
    } finally {
      await release();
    }
    await closing;
    // Long enough for a timer the shutdown failed to cancel to fire.
    await Bun.sleep(150);

    const messages = running.logs().map((line) => String(line.message));
    const published = messages.indexOf('outbox batch published');
    const stopped = messages.indexOf('outbox publisher stopped');
    expect(published).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(published);
    expect(messages.slice(stopped + 1).filter((message) => message.startsWith('outbox'))).toEqual(
      [],
    );
    expect((await rowsOf(wallet.id)).every((row) => row.published_at !== null)).toBe(true);
    expect(eventIds(await topic.collect((all) => all.length >= 4))).toEqual(
      rows.map((row) => row.id),
    );
  });
});
