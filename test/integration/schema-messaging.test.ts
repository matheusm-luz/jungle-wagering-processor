import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { expectRefused, migratedDatabase, SqlState } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { AT, newId } from '../support/schema-fixtures';

let sql: SQL;

beforeAll(async () => {
  sql = await migratedDatabase();
});

afterEach(async () => {
  await expectLedgerInvariant(sql);
});

afterAll(async () => {
  await sql.close();
});

const inboxRow = (consumerName: string, messageId: string) => ({
  consumer_name: consumerName,
  message_id: messageId,
  payload_hash: 'ab'.repeat(32),
  received_at: AT,
});

describe('inbox_messages', () => {
  test('refuses a second inbox row for the same consumer and message', async () => {
    const messageId = newId();
    await sql`insert into inbox_messages ${sql(inboxRow('wager-consumer', messageId))}`;

    await expectRefused(
      sql`insert into inbox_messages ${sql(inboxRow('wager-consumer', messageId))}`,
      { sqlState: SqlState.uniqueViolation, constraint: 'inbox_messages_pkey' },
    );
  });

  test('allows the same message id for another consumer', async () => {
    const messageId = newId();
    await sql`insert into inbox_messages ${sql(inboxRow('wager-consumer', messageId))}`;
    await sql`insert into inbox_messages ${sql(inboxRow('audit-consumer', messageId))}`;

    const [counted] = await sql`
      select count(*)::int as n from inbox_messages where message_id = ${messageId}`;
    expect(counted.n).toBe(2);
  });
});

describe('outbox_messages', () => {
  test('an outbox row starts unpublished with zero attempts and is found through the pending index', async () => {
    const id = newId();
    const payload = { eventId: id, eventType: 'WalletBalanceChanged', data: { amount: '10.00' } };
    await sql`
      insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
      values (${id}, ${newId()}, 'WalletBalanceChanged', ${payload}::jsonb, ${AT}, ${AT})`;

    const [stored] = await sql`
      select attempts, published_at, payload from outbox_messages where id = ${id}`;
    expect(stored).toEqual({ attempts: 0, published_at: null, payload });

    await expectRefused(sql`update outbox_messages set attempts = -1 where id = ${id}`, {
      sqlState: SqlState.checkViolation,
      constraint: 'outbox_messages_attempts_non_negative',
    });

    // The publisher's scan of S10 must be served by the partial index, not a sequential scan.
    const plan = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return tx`
        explain select id from outbox_messages
         where published_at is null and next_attempt_at <= now()
         order by next_attempt_at limit 10`;
    });
    expect(JSON.stringify(plan)).toContain('outbox_messages_pending');
  });
});
