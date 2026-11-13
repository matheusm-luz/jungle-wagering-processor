import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import type { UnitOfWork } from '../../src/application/ports';
import { ProcessWagerTransaction } from '../../src/application/process-wager-transaction';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
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
