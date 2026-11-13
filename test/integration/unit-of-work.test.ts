import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import {
  ExternalTransactionConflictError,
  IdempotencyKeyConflictError,
  WalletAlreadyExistsError,
} from '../../src/application/errors';
import type { TransactionScope } from '../../src/application/ports';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { Money } from '../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startOrm } from '../support/orm';
import { newId, seedWallet, unusedCurrency } from '../support/schema-fixtures';

let sql: SQL;
let orm: MikroORM;
let unitOfWork: MikroOrmUnitOfWork;

beforeAll(async () => {
  sql = await migratedDatabase();
  orm = await startOrm();
  unitOfWork = new MikroOrmUnitOfWork(orm, { newId });
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
    await scope.transactions.insert(transaction);
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
    await scope.transactions.insert(transaction);
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
