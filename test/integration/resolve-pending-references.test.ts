import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import type { Clock } from '../../src/application/ports';
import { ResolvePendingReferences } from '../../src/application/resolve-pending-references';
import { Metrics } from '../../src/infrastructure/metrics/metrics';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { startApp, type TestApp } from '../support/app';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startOrm } from '../support/orm';
import { newId } from '../support/schema-fixtures';

let sql: SQL;
let orm: MikroORM;
let app: TestApp;

beforeAll(async () => {
  sql = await migratedDatabase();
  orm = await startOrm();
  // The HTTP side only. Its worker idles (startApp's default), so each test drives the resolver.
  app = await startApp();
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await app.close();
  await orm.close();
  await sql.close();
});

const PROVIDER = 'provider-s7';
const ADR_05 = { baseDelayMs: 1000, maxDelayMs: 60_000, maxAttempts: 10 };

function resolver(clock: Clock = { now: () => new Date() }) {
  return new ResolvePendingReferences(
    new MikroOrmUnitOfWork(orm, { newId }, new Metrics()),
    clock,
    { newId },
    ADR_05,
  );
}

type Body = Record<string, unknown>;
type Result = { transactionId: string; status: string; [field: string]: unknown };
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

async function submit(body: Body, correlationId = `corr-${newId()}`) {
  const response = await fetch(`${app.url}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
      'X-Correlation-Id': correlationId,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, result: (await response.json()) as Result };
}

/** A REFUND sent before its BET: 202, waiting. Returns both bodies and the waiting row's id. */
async function refundBeforeBet(wallet: Wallet, amount = '30.00') {
  const bet = wager(wallet, 'BET', amount);
  const refund = wager(wallet, 'REFUND', amount, {
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  const sent = await submit(refund, 'refund-correlation');
  expect(sent.status).toBe(202);
  return { bet, refund, id: sent.result.transactionId };
}

async function row(id: string) {
  const [found] = await sql`
    select status, failure_code, reference_transaction_id, observed_balance, reference_attempts,
           next_attempt_at, processed_at is not null as processed
      from wager_transactions where id = ${id}`;
  return found;
}

async function walletRow(walletId: string) {
  const [found] = await sql`select balance, version from wallets where id = ${walletId}`;
  return found;
}

async function eventsOf(transactionId: string) {
  const rows = await sql`
    select event_type, payload->>'correlationId' as correlation_id from outbox_messages
     where payload->'data'->>'transactionId' = ${transactionId} order by event_type`;
  return rows as { event_type: string; correlation_id: string }[];
}

/** Ends a row a test leaves waiting, through the worker's own exhaustion path (S7 review, m6). */
async function exhaust(id: string, walletId: string) {
  await sql`
    update wager_transactions set reference_attempts = ${ADR_05.maxAttempts - 1}, next_attempt_at = now()
     where id = ${id}`;
  expect(String(await resolver().retry({ id, walletId }))).toBe('REJECTED');
}

describe('ResolvePendingReferences — one retry (ADR-05)', () => {
  test('the reference arrived: the REFUND is PROCESSED with its entry and events, and the replay of its key is 200', async () => {
    const wallet = await openWallet('100.00');
    const { bet, refund, id } = await refundBeforeBet(wallet);
    const placed = await submit(bet);
    expect(placed.status).toBe(200);

    await resolver().retry({ id, walletId: wallet.id });

    expect(await row(id)).toMatchObject({
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: placed.result.transactionId,
      observed_balance: '100.00',
      reference_attempts: 1,
      next_attempt_at: null,
      processed: true,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    const [entry] = await sql`
      select direction, amount from wallet_ledger_entries where transaction_id = ${id}`;
    expect(entry).toEqual({ direction: 'CREDIT', amount: '30.00' });
    // The request's correlation id travels to the events the worker emits (L-15, S7 Q1).
    expect(await eventsOf(id)).toEqual([
      { event_type: 'WagerTransactionPendingReference', correlation_id: 'refund-correlation' },
      { event_type: 'WagerTransactionProcessed', correlation_id: 'refund-correlation' },
      { event_type: 'WalletBalanceChanged', correlation_id: 'refund-correlation' },
    ]);

    const replay = await submit(refund);
    expect(replay).toEqual({
      status: 200,
      result: {
        transactionId: id,
        status: 'PROCESSED',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: true,
      },
    });
  });

  test('a reference rule now fails: REJECTED with that code and an event, nothing moved', async () => {
    const wallet = await openWallet('100.00');
    const { bet, id } = await refundBeforeBet(wallet, '30.00');
    expect((await submit({ ...bet, money: { amount: '40.00', currency: 'BRL' } })).status).toBe(
      200,
    );

    await resolver().retry({ id, walletId: wallet.id });

    expect(await row(id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_AMOUNT_MISMATCH',
      reference_transaction_id: null,
      observed_balance: '60.00',
      next_attempt_at: null,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '60.00', version: 2 });
    expect((await eventsOf(id)).map(({ event_type }) => event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });

  test('still missing: attempts + 1 and the next attempt pushed by the backoff, no event', async () => {
    const wallet = await openWallet('100.00');
    const { id } = await refundBeforeBet(wallet);
    const now = new Date(Date.now() + 5);

    await resolver({ now: () => now }).retry({ id, walletId: wallet.id });
    expect(await row(id)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 1,
      next_attempt_at: new Date(now.getTime() + 1000),
    });

    const later = new Date(now.getTime() + 1000);
    await resolver({ now: () => later }).retry({ id, walletId: wallet.id });
    expect(await row(id)).toMatchObject({
      reference_attempts: 2,
      next_attempt_at: new Date(later.getTime() + 2000),
    });
    expect((await eventsOf(id)).map(({ event_type }) => event_type)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    await exhaust(id, wallet.id);
  });

  test('a row that is not due yet, or no longer waiting, is skipped', async () => {
    const wallet = await openWallet('100.00');
    const { bet, id } = await refundBeforeBet(wallet);
    const now = new Date(Date.now() + 5);
    await resolver({ now: () => now }).retry({ id, walletId: wallet.id });
    await submit(bet);

    // Due only at now + 1s: a second worker that read it as due before must not count again.
    await resolver({ now: () => now }).retry({ id, walletId: wallet.id });
    expect(await row(id)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });

    const due = new Date(now.getTime() + 1000);
    await resolver({ now: () => due }).retry({ id, walletId: wallet.id });
    await resolver({ now: () => due }).retry({ id, walletId: wallet.id });
    expect(await row(id)).toMatchObject({ status: 'PROCESSED', reference_attempts: 2 });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
  });

  test('the 10th failed attempt is REJECTED with REFERENCE_NOT_FOUND, its event and no entry', async () => {
    const wallet = await openWallet('100.00');
    const { refund, id } = await refundBeforeBet(wallet);
    await sql`update wager_transactions set reference_attempts = 9 where id = ${id}`;

    await resolver().retry({ id, walletId: wallet.id });

    expect(await row(id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      observed_balance: '100.00',
      reference_attempts: 10,
      next_attempt_at: null,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await sql`select 1 from wallet_ledger_entries where transaction_id = ${id}`).toEqual([]);
    expect(await eventsOf(id)).toEqual([
      { event_type: 'WagerTransactionPendingReference', correlation_id: 'refund-correlation' },
      { event_type: 'WagerTransactionRejected', correlation_id: 'refund-correlation' },
    ]);
    expect(await submit(refund)).toEqual({
      status: 422,
      result: {
        transactionId: id,
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: true,
      },
    });
  });

  test('a ROLLBACK waiting on a waiting REFUND is applied after it (L-10)', async () => {
    const wallet = await openWallet('100.00');
    const { bet, refund, id: refundId } = await refundBeforeBet(wallet);
    const rollback = wager(wallet, 'ROLLBACK', '30.00', {
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    const rollbackId = (await submit(rollback)).result.transactionId;
    await submit(bet);

    // The ROLLBACK first: its REFUND still waits, so it waits too.
    await resolver().retry({ id: rollbackId, walletId: wallet.id });
    expect(await row(rollbackId)).toMatchObject({ status: 'PENDING_REFERENCE' });

    await resolver().retry({ id: refundId, walletId: wallet.id });
    await sql`update wager_transactions set next_attempt_at = now() where id = ${rollbackId}`;
    await resolver().retry({ id: rollbackId, walletId: wallet.id });

    expect(await row(refundId)).toMatchObject({ status: 'PROCESSED' });
    expect(await row(rollbackId)).toMatchObject({ status: 'PROCESSED' });
    // 100 − 30 (BET) + 30 (REFUND) − 30 (ROLLBACK of the REFUND); versions 2, 3 and 4.
    expect(await walletRow(wallet.id)).toEqual({ balance: '70.00', version: 4 });
  });
});

describe('ResolvePendingReferences — a retry that failed unexpectedly (S7 review, M1)', () => {
  test('postpone pushes the row by the maximum delay without counting an attempt', async () => {
    const wallet = await openWallet('100.00');
    const { id } = await refundBeforeBet(wallet);
    const now = new Date(Date.now() + 5);

    await resolver({ now: () => now }).postpone({ id, walletId: wallet.id });

    expect(await row(id)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 0,
      next_attempt_at: new Date(now.getTime() + ADR_05.maxDelayMs),
    });
    await exhaust(id, wallet.id);
  });
});

describe('ResolvePendingReferences — FAILED (S12, docs/tasks/S12.md Q2)', () => {
  test('a non-transient failure counts an attempt and postpones the row by the maximum delay', async () => {
    const wallet = await openWallet('100.00');
    const { id } = await refundBeforeBet(wallet);
    const now = new Date(Date.now() + 5);

    const outcome = await resolver({ now: () => now }).postpone(
      { id, walletId: wallet.id },
      { countsAttempt: true },
    );

    expect(outcome).toBe('postponed');
    expect(await row(id)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 1,
      next_attempt_at: new Date(now.getTime() + ADR_05.maxDelayMs),
    });
    await exhaust(id, wallet.id);
  });

  test('the 10th attempt ending in a non-transient failure is FAILED with PROCESSING_FAILED, its event and no entry; the replay of its key is 422', async () => {
    const wallet = await openWallet('100.00');
    const { refund, id } = await refundBeforeBet(wallet);
    await sql`update wager_transactions set reference_attempts = 9 where id = ${id}`;

    const outcome = await resolver().postpone({ id, walletId: wallet.id }, { countsAttempt: true });

    expect(outcome).toBe('FAILED');
    expect(await row(id)).toMatchObject({
      status: 'FAILED',
      failure_code: 'PROCESSING_FAILED',
      // FAILED keeps the balance observed when it started waiting (schema trigger).
      observed_balance: '100.00',
      reference_attempts: 10,
      next_attempt_at: null,
      processed: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await sql`select 1 from wallet_ledger_entries where transaction_id = ${id}`).toEqual([]);
    expect(await eventsOf(id)).toEqual([
      { event_type: 'WagerTransactionPendingReference', correlation_id: 'refund-correlation' },
      { event_type: 'WagerTransactionRejected', correlation_id: 'refund-correlation' },
    ]);
    const [event] = await sql`
      select payload->'data'->>'failureCode' as code from outbox_messages
       where event_type = 'WagerTransactionRejected' and payload->'data'->>'transactionId' = ${id}`;
    expect(event.code).toBe('PROCESSING_FAILED');
    // ARCHITECTURE §6 (docs/tasks/S12.md Q3): terminal, so the replay answers like a rejection.
    expect(await submit(refund)).toEqual({
      status: 422,
      result: {
        transactionId: id,
        status: 'FAILED',
        failureCode: 'PROCESSING_FAILED',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: true,
      },
    });
    const query = await fetch(`${app.url}/wagering/transactions/${id}`);
    expect(query.status).toBe(200);
    expect(await query.json()).toMatchObject({
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
    });
  });

  test('a transient failure never counts: the 10th postpone without counting leaves the row waiting', async () => {
    const wallet = await openWallet('100.00');
    const { id } = await refundBeforeBet(wallet);
    await sql`update wager_transactions set reference_attempts = 9 where id = ${id}`;

    expect(await resolver().postpone({ id, walletId: wallet.id })).toBe('postponed');
    expect(await row(id)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 9 });
    await exhaust(id, wallet.id);
  });
});

describe('ResolvePendingReferences — two workers (ADR-05)', () => {
  test('two resolvers retry the same 20 due rows in parallel: each REFUND is credited once and each row moves once', async () => {
    const rows = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const wallet = await openWallet('100.00');
        const { bet, id } = await refundBeforeBet(wallet);
        expect((await submit(bet)).status).toBe(200);
        return { id, walletId: wallet.id };
      }),
    );
    const [first, second] = [resolver(), resolver()];

    const outcomes = await Promise.all([
      ...rows.map((due) => first.retry(due)),
      ...rows.map((due) => second.retry(due)),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'PROCESSED')).toHaveLength(20);
    expect(outcomes.filter((outcome) => outcome === 'skipped')).toHaveLength(20);
    for (const { id, walletId } of rows) {
      expect(await row(id)).toMatchObject({ status: 'PROCESSED', reference_attempts: 1 });
      expect(await walletRow(walletId)).toEqual({ balance: '100.00', version: 3 });
      const entries = await sql`select 1 from wallet_ledger_entries where transaction_id = ${id}`;
      expect(entries).toHaveLength(1);
    }
  });
});

/** Polls an async read until it returns a value; the worker acts on its own schedule. */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(10);
  }
}

// Fast enough for a test, slow enough that a REFUND does not exhaust before its BET is sent.
const FAST_WORKER = {
  PENDING_REFERENCE_BASE_DELAY_MS: 50,
  PENDING_REFERENCE_MAX_DELAY_MS: 200,
  PENDING_REFERENCE_MAX_ATTEMPTS: 20,
  PENDING_REFERENCE_POLL_INTERVAL_MS: 20,
  PENDING_REFERENCE_BATCH_SIZE: 50,
};

describe('PendingReferenceWorker in the running application', () => {
  test('resolves a REFUND once its BET arrives over HTTP, and logs the retry', async () => {
    const worker = await startApp(FAST_WORKER);
    try {
      const wallet = await openWallet('100.00');
      const { bet, id } = await refundBeforeBet(wallet);
      expect((await submit(bet)).status).toBe(200);

      await until(async () => ((await row(id))?.status === 'PROCESSED' ? true : undefined));

      expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
      expect(worker.logs()).toContainEqual(
        expect.objectContaining({
          message: 'pending reference retried',
          outcome: 'PROCESSED',
          transactionId: id,
          walletId: wallet.id,
        }),
      );
    } finally {
      await worker.close();
    }
  }, 20_000);

  test('shutdown waits for the retry in flight and starts no new one', async () => {
    const wallet = await openWallet('100.00');
    const { bet, id } = await refundBeforeBet(wallet);
    expect((await submit(bet)).status).toBe(200);
    // Hold the wallet so the worker's retry blocks on its lock.
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
    await isLocked;

    const worker = await startApp(FAST_WORKER);
    await until(async () => {
      const [{ waiting }] = await sql`
        select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'
           and query ilike '%for update%'`;
      return waiting > 0 ? true : undefined;
    });
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Bun.sleep(100);
    expect(closed).toBe(false);

    release();
    await holder;
    await closing;
    // Long enough for a timer the shutdown failed to cancel to fire (poll interval 20 ms).
    await Bun.sleep(150);

    // The worker's own account, in order: the retry in flight finished, then the worker stopped,
    // then nothing. A worker that did not wait would log "stopped" first; one that kept its timer
    // would log a scan after it, against an ORM that is already closed.
    const lines = worker.logs().map((line) => ({
      message: String(line.message),
      transactionId: line.transactionId,
    }));
    const retried = lines.findIndex(
      (line) => line.message === 'pending reference retried' && line.transactionId === id,
    );
    const stopped = lines.findIndex((line) => line.message === 'pending reference worker stopped');
    expect(retried).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(retried);
    expect(
      lines.slice(stopped + 1).filter((line) => line.message.startsWith('pending reference')),
    ).toEqual([]);
    expect(await row(id)).toMatchObject({ status: 'PROCESSED' });
  }, 20_000);
});
