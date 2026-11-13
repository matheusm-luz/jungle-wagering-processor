import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { expectRefused, migratedDatabase, SqlState } from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import {
  accountRow,
  fundingAccountId,
  insertAccount,
  newId,
  unusedCurrency,
} from '../support/schema-fixtures';

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

describe('ledger_accounts', () => {
  test('allows one FUNDING account per currency', async () => {
    const currency = await unusedCurrency(sql);
    await insertAccount(sql, accountRow({ kind: 'FUNDING', provider_id: null, currency }));

    await expectRefused(
      insertAccount(sql, accountRow({ kind: 'FUNDING', provider_id: null, currency })),
      {
        sqlState: SqlState.uniqueViolation,
        constraint: 'ledger_accounts_kind_provider_currency_key',
      },
    );
  });

  test('allows one PROVIDER_SETTLEMENT account per provider and currency', async () => {
    const first = await insertAccount(sql);

    await expectRefused(insertAccount(sql, accountRow({ provider_id: first.provider_id })), {
      sqlState: SqlState.uniqueViolation,
      constraint: 'ledger_accounts_kind_provider_currency_key',
    });
    await insertAccount(sql, accountRow({ provider_id: first.provider_id, currency: 'USD' }));
  });

  test('refuses a FUNDING account with a provider and a settlement account without one', async () => {
    await expectRefused(insertAccount(sql, accountRow({ kind: 'FUNDING' })), {
      sqlState: SqlState.checkViolation,
      constraint: 'ledger_accounts_provider_only_for_settlement',
    });
    await expectRefused(insertAccount(sql, accountRow({ provider_id: null })), {
      sqlState: SqlState.checkViolation,
      constraint: 'ledger_accounts_provider_only_for_settlement',
    });
    await expectRefused(insertAccount(sql, accountRow({ kind: 'HOUSE' })), {
      sqlState: SqlState.checkViolation,
      constraint: 'ledger_accounts_kind_valid',
    });
  });

  test('INSERT … ON CONFLICT DO NOTHING finds the existing account', async () => {
    const currency = await unusedCurrency(sql);
    const first = await fundingAccountId(sql, currency);
    const second = await fundingAccountId(sql, currency);
    expect(second).toBe(first);

    const providerId = `provider-${newId()}`;
    const ids = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await sql`
        insert into ledger_accounts (id, kind, provider_id, currency, created_at)
        values (${newId()}, 'PROVIDER_SETTLEMENT', ${providerId}, 'BRL', now())
        on conflict do nothing`;
      const [row] = await sql`
        select id from ledger_accounts
         where kind = 'PROVIDER_SETTLEMENT' and provider_id = ${providerId} and currency = 'BRL'`;
      ids.add(row.id);
    }
    expect(ids.size).toBe(1);
  });
});
