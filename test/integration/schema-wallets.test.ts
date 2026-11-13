import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import {
  expectRefused,
  inRolledBackTransaction,
  migratedDatabase,
  SqlState,
} from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import { insertWallet, walletRow } from '../support/schema-fixtures';

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

describe('wallets', () => {
  test('refuses a second wallet for the same player and currency', async () => {
    const first = await insertWallet(sql);

    await expectRefused(insertWallet(sql, walletRow({ player_id: first.player_id })), {
      sqlState: SqlState.uniqueViolation,
      constraint: 'wallets_player_currency_key',
    });
    await insertWallet(sql, walletRow({ player_id: first.player_id, currency: 'USD' }));
  });

  test('refuses a negative balance', async () => {
    await expectRefused(insertWallet(sql, walletRow({ balance: '-0.01' })), {
      sqlState: SqlState.checkViolation,
      constraint: 'wallets_balance_non_negative',
    });

    const wallet = await insertWallet(sql);
    await expectRefused(sql`update wallets set balance = balance - 0.01 where id = ${wallet.id}`, {
      sqlState: SqlState.checkViolation,
      constraint: 'wallets_balance_non_negative',
    });
  });

  test('refuses a version below 1', async () => {
    await expectRefused(insertWallet(sql, walletRow({ version: 0 })), {
      sqlState: SqlState.checkViolation,
      constraint: 'wallets_version_positive',
    });
  });

  test('refuses a malformed currency', async () => {
    for (const currency of ['brl', 'BR', 'B1L']) {
      await expectRefused(insertWallet(sql, walletRow({ currency })), {
        sqlState: SqlState.checkViolation,
        constraint: 'wallets_currency_format',
      });
    }
  });

  test('stores the balance as NUMERIC(19,2) and returns it as a string', async () => {
    // A balance with no entry behind it would break the ledger invariant, so it never commits.
    await inRolledBackTransaction(sql, async (tx) => {
      const wallet = await insertWallet(tx, walletRow({ balance: '99999999999999999.99' }));

      const [row] = await tx`select balance, version from wallets where id = ${wallet.id}`;
      expect(row).toEqual({ balance: '99999999999999999.99', version: 1 });
    });

    // 22003: numeric_value_out_of_range, the column itself refuses an 18th integer digit.
    await expectRefused(insertWallet(sql, walletRow({ balance: '100000000000000000.00' })), {
      sqlState: '22003',
    });
  });
});
