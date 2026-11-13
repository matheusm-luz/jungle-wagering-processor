import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import type { InboxRecord } from '../../src/application/ports';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { migratedDatabase } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { startOrm } from '../support/orm';
import { newId } from '../support/schema-fixtures';

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

const message = (payloadHash = 'a'.repeat(64)): InboxRecord => ({
  consumerName: 'wager-transactions',
  messageId: `msg-${newId()}`,
  payloadHash,
  at: new Date('2026-11-13T18:00:00.000Z'),
});

describe('inbox (R-53)', () => {
  test('records a message once; the same id with the same hash is a duplicate, with another hash a conflict', async () => {
    const first = message();

    expect(await unitOfWork.run((scope) => scope.inbox.record(first))).toBe('new');
    expect(await unitOfWork.run((scope) => scope.inbox.record(first))).toBe('duplicate');
    expect(
      await unitOfWork.run((scope) =>
        scope.inbox.record({ ...first, payloadHash: 'b'.repeat(64) }),
      ),
    ).toBe('conflict');

    const rows = await sql`
      select payload_hash, processed_at from inbox_messages where message_id = ${first.messageId}`;
    expect(rows).toEqual([{ payload_hash: first.payloadHash, processed_at: first.at }]);
  });

  test('two concurrent records of one message: one new, one duplicate', async () => {
    const same = message();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The first transaction stays open; the second insert waits on the primary key until it commits.
    const first = unitOfWork.run(async (scope) => {
      const outcome = await scope.inbox.record(same);
      await gate;
      return outcome;
    });
    await Bun.sleep(50);
    const second = unitOfWork.run((scope) => scope.inbox.record(same));
    // The second insert is blocked on the primary key before the first commits (S9 review, m3).
    for (let waited = 0; ; waited += 10) {
      const [row] = await sql`
        select count(*)::int as n from pg_stat_activity
         where wait_event_type = 'Lock' and query like 'insert into inbox_messages%'`;
      if ((row?.n as number) > 0) break;
      if (waited > 5000) throw new Error('the second insert never waited');
      await Bun.sleep(10);
    }
    release();

    expect([await first, await second]).toEqual(['new', 'duplicate']);
  });

  test('a rolled-back transaction leaves no inbox row', async () => {
    const lost = message();
    const failure = new Error('after the inbox insert');

    await expect(
      unitOfWork.run(async (scope) => {
        await scope.inbox.record(lost);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await unitOfWork.run((scope) => scope.inbox.record(lost))).toBe('new');
  });
});
