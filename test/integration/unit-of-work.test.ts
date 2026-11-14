import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  WalletAlreadyExistsError,
} from '../../src/application/errors';
import type { TransactionScope } from '../../src/application/ports';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { Metrics } from '../../src/infrastructure/metrics/metrics';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { migratedDatabase, silentLogger, testEnv } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startOrm } from '../support/orm';
import {
  applyTransaction,
  newId,
  seedWallet,
  transactionRow,
  unusedCurrency,
} from '../support/schema-fixtures';

let sql: SQL;
let orm: MikroORM;
let unitOfWork: MikroOrmUnitOfWork;

beforeAll(async () => {
  sql = await migratedDatabase();
  orm = await startOrm();
  unitOfWork = new MikroOrmUnitOfWork(orm, { newId }, new Metrics());
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await orm.close();
  await sql.close();
});

const AT = new Date('2026-11-13T15:00:00.000Z');

/** What opening a wallet with a positive balance writes: the four kinds of row of R-43. */
function opening(
  playerId = `player-${newId()}`,
  money = Money.from({ amount: '50.00', currency: 'BRL' }),
) {
  const walletId = newId();
  const transactionId = newId();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: money,
    openingTransactionId: transactionId,
    openingEntryId: newId(),
    at: AT,
  });
  if (openingEntry === undefined) throw new Error('expected an opening entry');
  const transaction = WagerTransaction.create({
    id: transactionId,
    providerId: 'SYSTEM',
    externalTransactionId: `opening:${walletId}`,
    idempotencyKey: `opening:${walletId}`,
    payloadHash: 'd'.repeat(64),
    walletId,
    playerId,
    roundId: 'OPENING',
    gameId: 'OPENING',
    kind: WagerTransactionKind.Opening,
    money,
    createdAt: AT,
  });
  transaction.markProcessed(undefined, wallet.balance, AT);
  const ctx = (eventId: string) => ({ eventId, correlationId: 'correlation-1', occurredAt: AT });
  const events = [
    WagerTransactionProcessed.from(transaction, wallet, ctx(newId())),
    WalletBalanceChanged.from(wallet, openingEntry, ctx(newId())),
  ];

  const write = async (scope: TransactionScope) => {
    await scope.wallets.insert(wallet);
    await scope.transactions.insert(transaction, 'correlation-1');
    await scope.ledger.append(openingEntry, transaction.counterparty());
    await scope.outbox.enqueue(events);
  };

  return { wallet, transaction, entry: openingEntry, events, write };
}

async function rowCounts(o: ReturnType<typeof opening>) {
  const [row] = await sql`
    select (select count(*)::int from wallets where id = ${o.wallet.id}) as wallets,
           (select count(*)::int from wager_transactions where id = ${o.transaction.id}) as transactions,
           (select count(*)::int from wallet_ledger_entries where id = ${o.entry.id}) as entries,
           (select count(*)::int from outbox_messages
             where id in (${o.events[0]?.eventId}, ${o.events[1]?.eventId})) as outbox`;
  return row;
}

describe('MikroOrmUnitOfWork', () => {
  test('commits the wallet, the transaction, the entry and the outbox rows together', async () => {
    const o = opening();

    await unitOfWork.run(o.write);

    expect(await rowCounts(o)).toEqual({ wallets: 1, transactions: 1, entries: 1, outbox: 2 });
  });

  test('an error after every write rolls back the wallet, the transaction, the entry and the outbox rows', async () => {
    const o = opening();

    const run = unitOfWork.run(async (scope) => {
      await o.write(scope);
      throw new Error('injected failure after the last write');
    });

    await expect(run).rejects.toThrow('injected failure after the last write');
    expect(await rowCounts(o)).toEqual({ wallets: 0, transactions: 0, entries: 0, outbox: 0 });
  });

  test('the FUNDING account is created once and reused', async () => {
    const currency = await unusedCurrency(sql);
    const money = Money.from({ amount: '10.00', currency });
    const first = opening(undefined, money);
    const second = opening(undefined, money);

    await unitOfWork.run(first.write);
    await unitOfWork.run(second.write);

    const accounts = await sql`
      select id from ledger_accounts where kind = 'FUNDING' and currency = ${currency}`;
    const entries = await sql`
      select distinct counterparty_account_id as id from wallet_ledger_entries
       where id in (${first.entry.id}, ${second.entry.id})`;
    expect(accounts).toHaveLength(1);
    expect(entries).toEqual([{ id: accounts[0].id }]);
  });

  test('concurrent first openings in a new currency create one FUNDING account and all post against it', async () => {
    const currency = await unusedCurrency(sql);
    const money = Money.from({ amount: '10.00', currency });
    const openings = Array.from({ length: 8 }, () => opening(undefined, money));

    await Promise.all(openings.map((o) => unitOfWork.run(o.write)));

    const accounts = await sql`
      select id from ledger_accounts where kind = 'FUNDING' and currency = ${currency}`;
    const counterparties = await sql`
      select distinct counterparty_account_id as id from wallet_ledger_entries
       where id in ${sql(openings.map((o) => o.entry.id))}`;
    expect(accounts).toHaveLength(1);
    expect(counterparties).toEqual([{ id: accounts[0].id }]);
  });

  test('a rolled-back first opening in a new currency leaves no FUNDING account behind', async () => {
    const currency = await unusedCurrency(sql);
    const o = opening(undefined, Money.from({ amount: '10.00', currency }));

    const run = unitOfWork.run(async (scope) => {
      await o.write(scope);
      throw new Error('injected failure after the last write');
    });

    await expect(run).rejects.toThrow('injected failure after the last write');
    expect(await rowCounts(o)).toEqual({ wallets: 0, transactions: 0, entries: 0, outbox: 0 });
    expect(await sql`select id from ledger_accounts where currency = ${currency}`).toEqual([]);
  });

  test('a second wallet for the same player and currency is WalletAlreadyExistsError and writes nothing', async () => {
    const playerId = `player-${newId()}`;
    await unitOfWork.run(opening(playerId).write);
    const duplicate = opening(playerId);

    await expect(unitOfWork.run(duplicate.write)).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    expect(await rowCounts(duplicate)).toEqual({
      wallets: 0,
      transactions: 0,
      entries: 0,
      outbox: 0,
    });
  });

  test('an outbox row starts pending, due at once and carries the event envelope', async () => {
    const o = opening();
    await unitOfWork.run(o.write);

    const rows = await sql`
      select id, aggregate_id, event_type, payload, attempts, published_at,
             next_attempt_at = occurred_at as due_at_once
        from outbox_messages where aggregate_id = ${o.wallet.id} order by event_type`;
    expect(rows).toEqual(
      [...o.events]
        .sort((a, b) => a.eventType.localeCompare(b.eventType))
        .map((event) => ({
          id: event.eventId,
          aggregate_id: o.wallet.id,
          event_type: event.eventType,
          payload: JSON.parse(JSON.stringify(event)),
          attempts: 0,
          published_at: null,
          due_at_once: true,
        })),
    );
  });
});

/** A `BET` written the way `ProcessWagerTransaction` writes it: lock, movement, then the rows. */
function bet(
  walletId: string,
  amount = '30.00',
  overrides: Partial<CreateWagerTransactionProps> = {},
) {
  const id = newId();
  const externalTransactionId = `bet-${id}`;
  let transaction: WagerTransaction | undefined;
  const write = async (scope: TransactionScope, expectedVersion?: number) => {
    const wallet = await scope.wallets.lock(walletId);
    if (wallet === undefined) throw new Error('expected the wallet');
    const money = Money.from({ amount, currency: wallet.currency });
    transaction = WagerTransaction.create({
      id,
      providerId: 'provider-uow',
      externalTransactionId,
      idempotencyKey: `provider-uow:${externalTransactionId}`,
      payloadHash: 'e'.repeat(64),
      walletId,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money,
      createdAt: AT,
      ...overrides,
    });
    const lockedVersion = wallet.version;
    const entry = wallet.debit({ entryId: newId(), transactionId: id, money, at: AT });
    transaction.markProcessed(undefined, wallet.balance, AT);
    await scope.transactions.insert(transaction, 'correlation-1');
    await scope.ledger.append(entry, transaction.counterparty());
    await scope.wallets.update(wallet, expectedVersion ?? lockedVersion);
  };
  return { id, externalTransactionId, write, transaction: () => transaction };
}

async function walletState(walletId: string) {
  const [row] = await sql`select balance, version from wallets where id = ${walletId}`;
  const [{ count }] = await sql`
    select count(*)::int as count from wager_transactions where wallet_id = ${walletId}`;
  return { ...row, transactions: count };
}

describe('TransactionScope under the wallet lock', () => {
  test('lock returns the wallet and a second lock on it waits for the first commit', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const walletId = wallet.id as string;
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const first = unitOfWork.run(async (scope) => {
      const loaded = await scope.wallets.lock(walletId);
      expect(loaded?.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(loaded?.version).toBe(1);
      signalLocked();
      await held;
      order.push('first commits');
    });
    await locked;
    const second = unitOfWork.run(async (scope) => {
      await scope.wallets.lock(walletId);
      order.push('second holds the lock');
    });
    // Release only once PostgreSQL shows the second session blocked on the row lock (S4 review, m5).
    // Without the lock it never blocks, and this wait fails instead of a timing guess passing.
    const deadline = performance.now() + 5000;
    for (;;) {
      const [{ waiting }] = await sql`
        select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'
           and query ilike '%for update%'`;
      if (waiting > 0) break;
      if (performance.now() > deadline) throw new Error('the second lock never waited');
      await Bun.sleep(10);
    }
    order.push('first released');
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(['first released', 'first commits', 'second holds the lock']);
  });

  test('lock of an unknown wallet returns undefined', async () => {
    expect(await unitOfWork.run((scope) => scope.wallets.lock(newId()))).toBeUndefined();
  });

  test('update writes the new balance and version with the transaction and its entry', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const walletId = wallet.id as string;

    await unitOfWork.run(bet(walletId).write);

    expect(await walletState(walletId)).toEqual({ balance: '70.00', version: 2, transactions: 2 });
  });

  test('update refuses a stale version and the whole transaction rolls back', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const walletId = wallet.id as string;
    const stale = bet(walletId);

    await expect(unitOfWork.run((scope) => stale.write(scope, 7))).rejects.toThrow(
      'stale wallet version',
    );

    expect(await walletState(walletId)).toEqual({ balance: '100.00', version: 1, transactions: 1 });
  });

  test('an error after the wallet update rolls back the balance with every other write', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const walletId = wallet.id as string;
    const failing = bet(walletId);

    const run = unitOfWork.run(async (scope) => {
      await failing.write(scope);
      throw new Error('injected failure after the wallet update');
    });

    await expect(run).rejects.toThrow('injected failure after the wallet update');
    expect(await walletState(walletId)).toEqual({ balance: '100.00', version: 1, transactions: 1 });
    expect(
      await sql`select id from wallet_ledger_entries where transaction_id = ${failing.id}`,
    ).toEqual([]);
  });

  test('findByIdentity finds a transaction by key and by provider and external id', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const placed = bet(wallet.id as string);
    await unitOfWork.run(placed.write);
    const stored = placed.transaction();
    const find = (identity: {
      idempotencyKey: string;
      providerId: string;
      externalTransactionId: string;
    }) => unitOfWork.run((scope) => scope.transactions.findByIdentity(identity));

    const byKey = await find({
      idempotencyKey: `provider-uow:${placed.externalTransactionId}`,
      providerId: 'provider-uow',
      externalTransactionId: 'unused',
    });
    const byExternalId = await find({
      idempotencyKey: 'unused',
      providerId: 'provider-uow',
      externalTransactionId: placed.externalTransactionId,
    });
    const neither = await find({
      idempotencyKey: 'unused',
      providerId: 'other-provider',
      externalTransactionId: placed.externalTransactionId,
    });

    expect(byKey).toEqual([stored as WagerTransaction]);
    expect(byExternalId).toEqual([stored as WagerTransaction]);
    expect(neither).toEqual([]);
  });

  test('a duplicate idempotency key or provider and external id becomes a 409 error and writes nothing', async () => {
    const { wallet: first } = await seedWallet(sql, '100.00');
    const { wallet: second } = await seedWallet(sql, '100.00');
    const placed = bet(first.id as string);
    await unitOfWork.run(placed.write);

    const sameKey = bet(second.id as string, '30.00', {
      idempotencyKey: `provider-uow:${placed.externalTransactionId}`,
    });
    const sameExternalId = bet(second.id as string, '30.00', {
      externalTransactionId: placed.externalTransactionId,
    });

    await expect(unitOfWork.run(sameKey.write)).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(unitOfWork.run(sameExternalId.write)).rejects.toBeInstanceOf(
      ExternalTransactionConflictError,
    );
    expect(await walletState(second.id as string)).toEqual({
      balance: '100.00',
      version: 1,
      transactions: 1,
    });
  });
});

describe('TransactionScope reference reads (S6)', () => {
  test('findByExternalId finds a transaction of any wallet by provider and external id', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const placed = bet(wallet.id as string);
    await unitOfWork.run(placed.write);
    const find = (providerId: string, externalTransactionId: string) =>
      unitOfWork.run((scope) =>
        scope.transactions.findByExternalId(providerId, externalTransactionId),
      );

    expect(await find('provider-uow', placed.externalTransactionId)).toEqual(
      placed.transaction() as WagerTransaction,
    );
    expect(await find('other-provider', placed.externalTransactionId)).toBeUndefined();
    expect(await find('provider-uow', 'missing')).toBeUndefined();
  });

  test('hasProcessedReversal is true only for a PROCESSED REFUND or ROLLBACK of that reference', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const bet = await applyTransaction(sql, transactionRow(wallet, { amount: '10.00' }));
    const win = await applyTransaction(sql, transactionRow(wallet, { kind: 'WIN' }));
    const reverse = (reference: typeof bet, overrides: Record<string, unknown>) =>
      applyTransaction(
        sql,
        transactionRow(wallet, {
          kind: 'REFUND',
          reference_external_transaction_id: reference.external_transaction_id,
          reference_transaction_id: reference.id,
          ...overrides,
        }),
      );
    // A rejected reversal and a WIN referencing the BET do not count.
    await reverse(bet, {
      status: 'REJECTED',
      failure_code: 'REFERENCE_AMOUNT_MISMATCH',
      reference_transaction_id: null,
      processed_at: null,
    });
    await reverse(bet, { kind: 'WIN' });
    const has = (id: unknown) =>
      unitOfWork.run((scope) => scope.transactions.hasProcessedReversal(id as string));

    expect(await has(bet.id)).toBe(false);
    await reverse(win, { kind: 'ROLLBACK' });
    expect(await has(win.id)).toBe(true);
    await reverse(bet, {});
    expect(await has(bet.id)).toBe(true);
  });
});

/** A `REFUND` of a reference that does not exist, written the way the request path writes it. */
async function waitingRefund(walletId: string, createdAt: Date) {
  const id = newId();
  return unitOfWork.run(async (scope) => {
    const wallet = await scope.wallets.lock(walletId);
    if (wallet === undefined) throw new Error('expected the wallet');
    const transaction = WagerTransaction.create({
      id,
      providerId: 'provider-uow',
      externalTransactionId: `refund-${id}`,
      idempotencyKey: `provider-uow:refund-${id}`,
      payloadHash: 'f'.repeat(64),
      walletId,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '10.00', currency: wallet.currency }),
      referenceExternalTransactionId: `missing-${id}`,
      createdAt,
    });
    transaction.markPendingReference(wallet.balance);
    await scope.transactions.insert(transaction, `correlation-${id}`);
    return transaction;
  });
}

/**
 * Ends rows these tests leave waiting. They are due in the distant past, so a worker of a later
 * suite would otherwise retry them before its own rows (S7 review, m6).
 */
async function retire(...transactions: WagerTransaction[]) {
  for (const transaction of transactions) {
    transaction.reject(FailureCode.ReferenceNotFound, transaction.observedBalance as Money);
    await unitOfWork.run((scope) => scope.transactions.finish(transaction, 0));
  }
}

async function scheduleOf(id: string) {
  const [row] = await sql`
    select status, failure_code, reference_attempts, next_attempt_at, correlation_id
      from wager_transactions where id = ${id}`;
  return row;
}

describe('TransactionScope pending references (S7)', () => {
  // Far in the past and earlier on every run, so no row left by an earlier run, another test or
  // another suite is due at the instants findDuePending is asked about.
  const EPOCH = Date.parse('2001-01-01T00:00:00.000Z') - Date.now();
  const LATER = 1e9;
  const at = (ms: number) => new Date(EPOCH + ms);

  test('findDuePending returns due PENDING_REFERENCE rows oldest first, up to the limit', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const walletId = wallet.id as string;
    const late = await waitingRefund(walletId, at(30));
    const early = await waitingRefund(walletId, at(10));
    const middle = await waitingRefund(walletId, at(20));
    const notDue = await waitingRefund(walletId, at(5000));
    const found = (transaction: WagerTransaction) => ({
      id: transaction.id,
      walletId,
      providerId: 'provider-uow',
      correlationId: `correlation-${transaction.id}`,
    });

    const due = (now: Date, limit: number) =>
      unitOfWork.run((scope) => scope.transactions.findDuePending(now, limit));

    // Rows of other tests are due long after EPOCH; only these four can match.
    expect((await due(at(30), 10)).map(({ id }) => id)).toHaveLength(3);
    expect(await due(at(30), 2)).toEqual([found(early), found(middle)]);
    expect((await due(at(30), 10)).at(-1)).toEqual(found(late));
    await retire(late, early, middle, notDue);
  });

  test('loadPending returns the row with its attempts and correlation id, and undefined once terminal', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const refund = await waitingRefund(wallet.id as string, at(LATER));

    const pending = await unitOfWork.run((scope) => scope.transactions.loadPending(refund.id));

    expect(pending).toEqual({
      transaction: expect.objectContaining({ id: refund.id }),
      attempts: 0,
      nextAttemptAt: at(LATER),
      correlationId: `correlation-${refund.id}`,
    });
    expect(pending?.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    const settled = pending?.transaction as WagerTransaction;
    settled.reject(FailureCode.ReferenceNotFound, settled.observedBalance as Money);
    await unitOfWork.run((scope) => scope.transactions.finish(settled, 10));
    expect(
      await unitOfWork.run((scope) => scope.transactions.loadPending(refund.id)),
    ).toBeUndefined();
  });

  test('reschedule writes the attempts and the next attempt', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const refund = await waitingRefund(wallet.id as string, at(LATER));

    await unitOfWork.run((scope) => scope.transactions.reschedule(refund.id, 3, at(LATER + 4000)));

    expect(await scheduleOf(refund.id)).toEqual({
      status: 'PENDING_REFERENCE',
      failure_code: null,
      reference_attempts: 3,
      next_attempt_at: at(LATER + 4000),
      correlation_id: `correlation-${refund.id}`,
    });
    await retire(refund);
  });

  test('finish writes the terminal state of a waiting row and refuses one that is no longer waiting', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const refund = await waitingRefund(wallet.id as string, at(LATER));
    refund.reject(FailureCode.ReferenceNotFound, refund.observedBalance as Money);

    await unitOfWork.run((scope) => scope.transactions.finish(refund, 10));

    expect(await scheduleOf(refund.id)).toEqual({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: 10,
      next_attempt_at: null,
      correlation_id: `correlation-${refund.id}`,
    });
    await expect(unitOfWork.run((scope) => scope.transactions.finish(refund, 10))).rejects.toThrow(
      'not waiting',
    );
    await expect(
      unitOfWork.run((scope) => scope.transactions.reschedule(refund.id, 11, at(LATER))),
    ).rejects.toThrow('not waiting');
  });
});

describe('idle in transaction timeout (S10 review, m1)', () => {
  test('a session idle inside its transaction past the timeout is ended by the server, and its wallet lock released', async () => {
    const shortOrm = await MikroORM.init(
      buildOrmConfig({ ...testEnv, DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: 300 }, silentLogger),
    );
    const { wallet } = await seedWallet(sql, '10.00');
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    try {
      // Stands for a client that vanished with the lock held: it never sends another statement.
      const abandoned = new MikroOrmUnitOfWork(shortOrm, { newId }, new Metrics())
        .run(async (scope) => {
          await scope.wallets.lock(wallet.id as string);
          locked();
          await Bun.sleep(2000);
        })
        .catch((error: unknown) => error);
      await isLocked;

      // Without the timeout this waits until the abandoned transaction ends, 2 s later.
      const started = performance.now();
      await sql.begin(async (tx) => {
        await tx`set local lock_timeout = '1500ms'`;
        await tx`select id from wallets where id = ${wallet.id as string} for update`;
      });
      expect(performance.now() - started).toBeLessThan(1500);
      expect(await abandoned).toBeInstanceOf(Error);
    } finally {
      await shortOrm.close();
    }
  });
});

describe('lock timeout (ADR-01, docs/tasks/S9.md Q2)', () => {
  test('a wallet held longer than the lock timeout fails the waiting transaction with 55P03', async () => {
    const shortOrm = await MikroORM.init(
      buildOrmConfig({ ...testEnv, DATABASE_LOCK_TIMEOUT_MS: 200 }, silentLogger),
    );
    const waiting = new MikroOrmUnitOfWork(shortOrm, { newId }, new Metrics());
    const { wallet } = await seedWallet(sql, '10.00');
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const holder = sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${wallet.id as string} for update`;
      locked();
      await held;
    });
    await isLocked;
    try {
      const started = performance.now();
      const error = await waiting
        .run((scope) => scope.wallets.lock(wallet.id as string))
        .then(
          () => undefined,
          (caught: unknown) => caught as { code?: string },
        );
      expect(error?.code).toBe('55P03');
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      release();
      await holder;
      await shortOrm.close();
    }
  });
});
