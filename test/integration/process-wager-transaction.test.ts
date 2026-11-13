import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { InboxMessageConflictError } from '../../src/application/errors';
import type { UnitOfWork } from '../../src/application/ports';
import { ProcessWagerTransaction } from '../../src/application/process-wager-transaction';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startOrm } from '../support/orm';
import { newId, seedWallet } from '../support/schema-fixtures';

let sql: SQL;
let orm: MikroORM;

beforeAll(async () => {
  sql = await migratedDatabase();
  orm = await startOrm();
});

afterAll(async () => {
  await expectLedgerInvariant(sql);
  await orm.close();
  await sql.close();
});

describe('ProcessWagerTransaction', () => {
  test('times the movement after the wallet lock, so they follow the wallet version (S4 review, m1)', async () => {
    const arrival = new Date('2026-11-13T10:00:00.000Z');
    const afterLock = new Date('2026-11-13T10:00:05.000Z');
    let now = arrival;
    const real = new MikroOrmUnitOfWork(orm, { newId });
    // Time passes while the request waits for the lock.
    const slowLock: UnitOfWork = {
      run: (work) =>
        real.run((scope) =>
          work({
            ...scope,
            wallets: {
              ...scope.wallets,
              lock: async (walletId) => {
                const wallet = await scope.wallets.lock(walletId);
                now = afterLock;
                return wallet;
              },
            },
          }),
        ),
    };
    const useCase = new ProcessWagerTransaction(slowLock, { now: () => now }, { newId });
    const { wallet } = await seedWallet(sql, '100.00');
    const externalTransactionId = `tx-${newId()}`;

    const { transaction } = await useCase.execute({
      idempotencyKey: `provider-s4:${externalTransactionId}`,
      providerId: 'provider-s4',
      externalTransactionId,
      playerId: wallet.player_id as string,
      walletId: wallet.id as string,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      correlationId: 'timing-1',
    });

    const [times] = await sql`
      select t.created_at, t.processed_at, w.updated_at,
             (select e.created_at from wallet_ledger_entries e where e.transaction_id = t.id) as entry_at,
             (select array_agg(distinct o.occurred_at) from outbox_messages o
               where o.payload->'data'->>'transactionId' = ${transaction.id}::text) as events_at
        from wager_transactions t join wallets w on w.id = t.wallet_id
       where t.id = ${transaction.id}`;
    expect(times).toEqual({
      created_at: arrival,
      processed_at: afterLock,
      updated_at: afterLock,
      entry_at: afterLock,
      events_at: [afterLock],
    });
  });

  test('a failure after the outbox write leaves no transaction, no entry, no event and the balance unchanged', async () => {
    const real = new MikroOrmUnitOfWork(orm, { newId });
    // The real transaction, with every write sent, then a crash before COMMIT.
    const failingAfterOutbox: UnitOfWork = {
      run: (work) =>
        real.run((scope) =>
          work({
            ...scope,
            outbox: {
              enqueue: async (events) => {
                await scope.outbox.enqueue(events);
                throw new Error('injected failure after the outbox write');
              },
            },
          }),
        ),
    };
    const useCase = new ProcessWagerTransaction(
      failingAfterOutbox,
      { now: () => new Date() },
      { newId },
    );
    const { wallet } = await seedWallet(sql, '100.00');
    const walletId = wallet.id as string;
    const externalTransactionId = `tx-${newId()}`;

    const run = useCase.execute({
      idempotencyKey: `provider-s4:${externalTransactionId}`,
      providerId: 'provider-s4',
      externalTransactionId,
      playerId: wallet.player_id as string,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      correlationId: 'rollback-1',
    });

    await expect(run).rejects.toThrow('injected failure after the outbox write');
    const [state] = await sql`
      select w.balance, w.version,
             (select count(*)::int from wager_transactions t
               where t.external_transaction_id = ${externalTransactionId}) as transactions,
             (select count(*)::int from wallet_ledger_entries e where e.wallet_id = w.id) as entries,
             (select count(*)::int from outbox_messages o where o.aggregate_id = w.id) as events
        from wallets w where w.id = ${walletId}`;
    expect(state).toEqual({
      balance: '100.00',
      version: 1,
      transactions: 0,
      entries: 1,
      events: 0,
    });
  });
});

describe('ProcessWagerTransaction.executeMessage (ARCHITECTURE §2 step 4)', () => {
  const inbox = () => ({ consumerName: 'wager-transactions', messageId: `msg-${newId()}` });

  async function bet(walletAmount = '100.00') {
    const { wallet } = await seedWallet(sql, walletAmount);
    const externalTransactionId = `tx-${newId()}`;
    return {
      walletId: wallet.id as string,
      command: {
        idempotencyKey: `provider-s9:${externalTransactionId}`,
        providerId: 'provider-s9',
        externalTransactionId,
        playerId: wallet.player_id as string,
        walletId: wallet.id as string,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        correlationId: 'msg-correlation',
      },
    };
  }

  const effects = async (walletId: string, messageId: string) => {
    const [state] = await sql`
      select w.balance,
             (select count(*)::int from wager_transactions t where t.wallet_id = w.id and t.kind = 'BET') as bets,
             (select count(*)::int from inbox_messages i where i.message_id = ${messageId}) as inbox
        from wallets w where w.id = ${walletId}`;
    return state;
  };

  test('a message is applied once with its inbox row; the same message again is a duplicate with no second effect', async () => {
    const useCase = new ProcessWagerTransaction(
      new MikroOrmUnitOfWork(orm, { newId }),
      { now: () => new Date() },
      { newId },
    );
    const { walletId, command } = await bet();
    const message = inbox();

    const first = await useCase.executeMessage(command, message);
    const again = await useCase.executeMessage(command, message);

    expect(typeof first === 'object' ? first.transaction.status : first).toBe(
      WagerTransactionStatus.Processed,
    );
    expect(again).toBe('duplicate');
    expect(await effects(walletId, message.messageId)).toEqual({
      balance: '70.00',
      bets: 1,
      inbox: 1,
    });
  });

  test('the same message id with another payload is an InboxMessageConflictError', async () => {
    const useCase = new ProcessWagerTransaction(
      new MikroOrmUnitOfWork(orm, { newId }),
      { now: () => new Date() },
      { newId },
    );
    const { walletId, command } = await bet();
    const message = inbox();
    await useCase.executeMessage(command, message);

    const other = { ...command, money: Money.from({ amount: '31.00', currency: 'BRL' }) };
    await expect(useCase.executeMessage(other, message)).rejects.toBeInstanceOf(
      InboxMessageConflictError,
    );
    expect(await effects(walletId, message.messageId)).toEqual({
      balance: '70.00',
      bets: 1,
      inbox: 1,
    });
  });

  test('the same message id with another idempotency key is an InboxMessageConflictError (PR #9 review)', async () => {
    const useCase = new ProcessWagerTransaction(
      new MikroOrmUnitOfWork(orm, { newId }),
      { now: () => new Date() },
      { newId },
    );
    const { walletId, command } = await bet();
    const message = inbox();
    await useCase.executeMessage(command, message);

    const otherKey = { ...command, idempotencyKey: `other-key-${newId()}` };
    await expect(useCase.executeMessage(otherKey, message)).rejects.toBeInstanceOf(
      InboxMessageConflictError,
    );
    expect(await effects(walletId, message.messageId)).toEqual({
      balance: '70.00',
      bets: 1,
      inbox: 1,
    });
  });

  test('a message for an unknown wallet commits only its inbox row (L-08)', async () => {
    const useCase = new ProcessWagerTransaction(
      new MikroOrmUnitOfWork(orm, { newId }),
      { now: () => new Date() },
      { newId },
    );
    const { command } = await bet();
    const message = inbox();
    const unknown = { ...command, walletId: newId() };

    expect(await useCase.executeMessage(unknown, message)).toBe('walletNotFound');
    expect(await useCase.executeMessage(unknown, message)).toBe('duplicate');
    const [rows] = await sql`
      select (select count(*)::int from inbox_messages where message_id = ${message.messageId}) as inbox,
             (select count(*)::int from wager_transactions
               where external_transaction_id = ${command.externalTransactionId}) as transactions`;
    expect(rows).toEqual({ inbox: 1, transactions: 0 });
  });

  test('a failure after the inbox insert rolls the inbox row back with the effects', async () => {
    const real = new MikroOrmUnitOfWork(orm, { newId });
    const failingAfterOutbox: UnitOfWork = {
      run: (work) =>
        real.run((scope) =>
          work({
            ...scope,
            outbox: {
              enqueue: async (events) => {
                await scope.outbox.enqueue(events);
                throw new Error('injected failure before commit');
              },
            },
          }),
        ),
    };
    const failing = new ProcessWagerTransaction(
      failingAfterOutbox,
      { now: () => new Date() },
      { newId },
    );
    const { walletId, command } = await bet();
    const message = inbox();

    await expect(failing.executeMessage(command, message)).rejects.toThrow(
      'injected failure before commit',
    );
    expect(await effects(walletId, message.messageId)).toEqual({
      balance: '100.00',
      bets: 0,
      inbox: 0,
    });
  });
});
