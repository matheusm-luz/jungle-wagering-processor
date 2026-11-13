import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { WalletAlreadyExistsError } from '../../src/application/errors';
import type { TransactionScope } from '../../src/application/ports';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startOrm } from '../support/orm';
import { newId, unusedCurrency } from '../support/schema-fixtures';

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
