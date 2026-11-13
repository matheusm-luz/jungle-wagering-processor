import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import {
  expectRefused,
  inRolledBackTransaction,
  migratedDatabase,
  SqlState,
} from '../support/database';
import { expectLedgerInvariant, findLedgerProblems } from '../support/ledger-invariant';
import {
  accountRow,
  applyTransaction,
  entryRow,
  insertAccount,
  insertEntry,
  insertTransaction,
  type Row,
  type SeededWallet,
  seedWallet,
  transactionRow,
} from '../support/schema-fixtures';

let sql: SQL;
let seeded: SeededWallet;
let settlement: Row;

beforeAll(async () => {
  sql = await migratedDatabase();
  seeded = await seedWallet(sql, '100.00');
  settlement = await insertAccount(sql);
});

afterEach(async () => {
  await expectLedgerInvariant(sql);
});

afterAll(async () => {
  await sql.close();
});

/**
 * Inserts a processed `BET` of 30.00 on the seeded wallet and its debit at sequence 2, with
 * `overrides` applied to the entry, in one SQL transaction. When the entry is refused the `BET`
 * is rolled back with it, so no processed transaction is left without its entry.
 */
function debitWith(overrides: Row = {}): Promise<void> {
  const bet = transactionRow(seeded.wallet, { amount: '30.00' });
  const entry = entryRow({
    wallet_id: seeded.wallet.id,
    transaction_id: bet.id,
    counterparty_account_id: settlement.id,
    direction: 'DEBIT',
    amount: '30.00',
    balance_before: '100.00',
    balance_after: '70.00',
    sequence: 2,
    ...overrides,
  });
  return sql.begin(async (tx) => {
    await insertTransaction(tx, bet);
    await insertEntry(tx, entry);
  });
}

const check = (constraint: string) => ({ sqlState: SqlState.checkViolation, constraint });
const foreignKey = (constraint: string) => ({ sqlState: SqlState.foreignKeyViolation, constraint });
const raised = (message: RegExp) => ({ sqlState: SqlState.raiseException, message });

describe('wallet_ledger_entries', () => {
  test('refuses broken arithmetic for a debit and for a credit', async () => {
    await expectRefused(
      debitWith({ balance_after: '80.00' }),
      check('wallet_ledger_entries_arithmetic'),
    );
    await expectRefused(
      debitWith({ direction: 'CREDIT' }),
      check('wallet_ledger_entries_arithmetic'),
    );
    await expectRefused(
      debitWith({ direction: 'SIDEWAYS' }),
      check('wallet_ledger_entries_direction_valid'),
    );
  });

  test('refuses a zero amount, a negative balance before or after and a sequence below 1', async () => {
    await expectRefused(
      debitWith({ amount: '0.00', balance_after: '100.00' }),
      check('wallet_ledger_entries_amount_positive'),
    );
    await expectRefused(
      debitWith({ amount: '130.00', balance_after: '-30.00' }),
      check('wallet_ledger_entries_balance_after_non_negative'),
    );
    await expectRefused(
      debitWith({
        direction: 'CREDIT',
        amount: '30.00',
        balance_before: '-30.00',
        balance_after: '0.00',
      }),
      check('wallet_ledger_entries_balance_before_non_negative'),
    );
    await expectRefused(
      debitWith({ sequence: 0 }),
      check('wallet_ledger_entries_sequence_positive'),
    );
  });

  test('refuses a second entry for the same transaction and wallet', async () => {
    await expectRefused(
      insertEntry(
        sql,
        entryRow({
          wallet_id: seeded.wallet.id,
          transaction_id: seeded.opening?.id,
          counterparty_account_id: seeded.fundingAccountId,
          amount: '100.00',
          balance_before: '100.00',
          balance_after: '200.00',
          sequence: 2,
        }),
      ),
      {
        sqlState: SqlState.uniqueViolation,
        constraint: 'wallet_ledger_entries_transaction_wallet_key',
      },
    );
  });

  test('refuses a second entry with the same wallet sequence', async () => {
    await expectRefused(debitWith({ sequence: 1 }), {
      sqlState: SqlState.uniqueViolation,
      constraint: 'wallet_ledger_entries_wallet_sequence_key',
    });
  });

  test('refuses an entry without a counterparty account', async () => {
    await expectRefused(debitWith({ counterparty_account_id: null }), {
      sqlState: SqlState.notNullViolation,
    });
  });

  test('refuses an entry whose currency differs from the wallet or the account', async () => {
    await expectRefused(
      debitWith({ currency: 'USD' }),
      foreignKey('wallet_ledger_entries_wallet_fk'),
    );

    const dollars = await insertAccount(sql, accountRow({ currency: 'USD' }));
    await expectRefused(
      debitWith({ counterparty_account_id: dollars.id }),
      foreignKey('wallet_ledger_entries_counterparty_fk'),
    );
  });

  test('refuses an entry whose wallet is not the wallet of its transaction', async () => {
    const other = await seedWallet(sql, '100.00');
    const foreign = await insertTransaction(
      sql,
      transactionRow(other.wallet, {
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
        processed_at: null,
      }),
    );

    await expectRefused(
      insertEntry(
        sql,
        entryRow({
          wallet_id: seeded.wallet.id,
          transaction_id: foreign.id,
          counterparty_account_id: settlement.id,
          direction: 'DEBIT',
          amount: '30.00',
          balance_before: '100.00',
          balance_after: '70.00',
          sequence: 2,
        }),
      ),
      foreignKey('wallet_ledger_entries_transaction_fk'),
    );
  });

  test('UPDATE, DELETE and TRUNCATE are refused', async () => {
    const [{ id }] = await sql`
      select id from wallet_ledger_entries where wallet_id = ${seeded.wallet.id} and sequence = 1`;

    await expectRefused(
      sql`update wallet_ledger_entries set created_at = now() where id = ${id}`,
      raised(/UPDATE on wallet_ledger_entries is not allowed/),
    );
    await expectRefused(
      sql`delete from wallet_ledger_entries where id = ${id}`,
      raised(/DELETE on wallet_ledger_entries is not allowed/),
    );
    await expectRefused(
      sql`truncate wallet_ledger_entries`,
      raised(/TRUNCATE on wallet_ledger_entries is not allowed/),
    );

    const [stored] = await sql`
      select amount, balance_after from wallet_ledger_entries where id = ${id}`;
    expect(stored).toEqual({ amount: '100.00', balance_after: '100.00' });
  });

  test('a valid debit is accepted and keeps the ledger invariant with its wallet', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    await applyTransaction(sql, transactionRow(wallet, { amount: '30.00' }));

    const [stored] = await sql`select balance, version from wallets where id = ${wallet.id}`;
    expect(stored).toEqual({ balance: '70.00', version: 2 });
  });
});

describe('ledger invariant helper', () => {
  const problemsOf = async (tx: SQL, walletId: unknown) =>
    (await findLedgerProblems(tx)).filter((problem) => problem.walletId === walletId);

  test('reports a balance or a version that the entries do not explain', async () => {
    const { wallet } = await seedWallet(sql, '100.00');

    await inRolledBackTransaction(sql, async (tx) => {
      await tx`update wallets set balance = balance + 0.01 where id = ${wallet.id}`;
      expect(await problemsOf(tx, wallet.id)).toEqual([
        { walletId: wallet.id as string, problem: 'BALANCE', detail: '100.01 <> 100.00' },
      ]);
    });
    await inRolledBackTransaction(sql, async (tx) => {
      await tx`update wallets set version = 3 where id = ${wallet.id}`;
      expect(await problemsOf(tx, wallet.id)).toEqual([
        { walletId: wallet.id as string, problem: 'VERSION', detail: '3 <> 1' },
      ]);
    });
  });

  test('reports a currency whose wallets and system accounts do not net to zero (ADR-12 trial balance)', async () => {
    const { wallet } = await seedWallet(sql, '100.00');
    const trialBalance = async (tx: SQL) =>
      (await findLedgerProblems(tx)).filter((problem) => problem.problem === 'TRIAL_BALANCE');
    expect(await trialBalance(sql)).toEqual([]);

    await inRolledBackTransaction(sql, async (tx) => {
      await tx`update wallets set balance = balance + 0.01 where id = ${wallet.id}`;
      expect(await trialBalance(tx)).toEqual([
        {
          walletId: wallet.currency as string,
          problem: 'TRIAL_BALANCE',
          detail: expect.any(String),
        },
      ]);
    });
  });

  test('reports a processed transaction without its entry and an entry that should not exist', async () => {
    const { wallet } = await seedWallet(sql, '100.00');

    await inRolledBackTransaction(sql, async (tx) => {
      const bet = await insertTransaction(tx, transactionRow(wallet));
      expect(await problemsOf(tx, wallet.id)).toEqual([
        { walletId: wallet.id as string, problem: 'MISSING_ENTRY', detail: bet.id as string },
      ]);
    });
    await inRolledBackTransaction(sql, async (tx) => {
      const loss = await insertTransaction(tx, transactionRow(wallet, { kind: 'LOSS' }));
      const entry = await insertEntry(
        tx,
        entryRow({
          wallet_id: wallet.id,
          transaction_id: loss.id,
          counterparty_account_id: settlement.id,
          balance_before: '100.00',
          balance_after: '110.00',
          sequence: 2,
        }),
      );
      await tx`update wallets set balance = 110.00, version = 2 where id = ${wallet.id}`;
      expect(await problemsOf(tx, wallet.id)).toEqual([
        { walletId: wallet.id as string, problem: 'UNEXPECTED_ENTRY', detail: entry.id as string },
      ]);
    });
  });

  test('reports an entry in the wrong direction and a broken chain', async () => {
    const { wallet } = await seedWallet(sql, '100.00');

    await inRolledBackTransaction(sql, async (tx) => {
      // A BET that credits: balanced row, consistent wallet, wrong direction for its kind.
      const bet = await insertTransaction(tx, transactionRow(wallet));
      await insertEntry(
        tx,
        entryRow({
          wallet_id: wallet.id,
          transaction_id: bet.id,
          counterparty_account_id: settlement.id,
          balance_before: '100.00',
          balance_after: '110.00',
          sequence: 2,
        }),
      );
      await tx`update wallets set balance = 110.00, version = 2 where id = ${wallet.id}`;
      expect(await problemsOf(tx, wallet.id)).toEqual([
        { walletId: wallet.id as string, problem: 'MISSING_ENTRY', detail: bet.id as string },
      ]);
    });
    await inRolledBackTransaction(sql, async (tx) => {
      // A WIN whose entry starts from a balance the previous entry did not leave, at sequence 3.
      const win = await insertTransaction(tx, transactionRow(wallet, { kind: 'WIN' }));
      const entry = await insertEntry(
        tx,
        entryRow({
          wallet_id: wallet.id,
          transaction_id: win.id,
          counterparty_account_id: settlement.id,
          balance_before: '90.00',
          balance_after: '100.00',
          sequence: 3,
        }),
      );
      await tx`update wallets set balance = 110.00, version = 3 where id = ${wallet.id}`;
      expect(await problemsOf(tx, wallet.id)).toEqual([
        { walletId: wallet.id as string, problem: 'CHAIN', detail: entry.id as string },
      ]);
    });
  });
});
