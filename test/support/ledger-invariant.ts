import { expect } from 'bun:test';
import type { SQL } from 'bun';
import { migratedDatabase } from './database';

export type LedgerProblemKind =
  /** The wallet balance differs from credits minus debits of its entries. */
  | 'BALANCE'
  /** The wallet version differs from the sequence of its last entry (1 when it has none). */
  | 'VERSION'
  /** An entry does not continue the previous one: balance or sequence skips. */
  | 'CHAIN'
  /** A processed transaction that moves money has no matching entry (amount, currency, direction). */
  | 'MISSING_ENTRY'
  /** An entry belongs to a transaction that moves no money (`LOSS`, or not `PROCESSED`). */
  | 'UNEXPECTED_ENTRY';

export interface LedgerProblem {
  walletId: string;
  problem: LedgerProblemKind;
  /** The offending entry or transaction id, or the two values that differ. */
  detail: string;
}

/**
 * Every disagreement between the materialised state and the ledger, over the whole database: the
 * ledger cannot be cleaned between tests, so a broken row left by any test fails every later one.
 *
 * Besides `wallet.balance == balance rebuilt from the ledger`, it checks that each entry continues
 * the previous one, and that exactly the processed transactions that move money have one entry
 * of their amount, currency and direction (`BET` debits, `ROLLBACK` inverts its reference, every
 * other kind credits).
 */
export async function findLedgerProblems(sql: SQL): Promise<LedgerProblem[]> {
  return sql`
    with sums as (
      select w.id, w.balance, w.version,
             coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)
               as rebuilt,
             coalesce(max(e.sequence), 1) as last_sequence
        from wallets w
        left join wallet_ledger_entries e on e.wallet_id = w.id
       group by w.id
    ),
    chained as (
      select e.*,
             row_number() over w as position,
             lag(e.balance_after) over w as previous_after,
             lag(e.sequence) over w as previous_sequence
        from wallet_ledger_entries e
      window w as (partition by e.wallet_id order by e.sequence)
    ),
    expected as (
      select t.*,
             case t.kind
               when 'BET' then 'DEBIT'
               when 'ROLLBACK' then (
                 select case r.direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end
                   from wallet_ledger_entries r
                  where r.transaction_id = t.reference_transaction_id)
               else 'CREDIT'
             end as expected_direction
        from wager_transactions t
       where t.status = 'PROCESSED' and t.kind <> 'LOSS'
    )
    select id as "walletId", 'BALANCE' as problem, balance::text || ' <> ' || rebuilt::text as detail
      from sums where balance <> rebuilt
    union all
    select id, 'VERSION', version::text || ' <> ' || last_sequence::text
      from sums where version <> last_sequence
    union all
    -- A wallet opened with a balance starts at sequence 1; one opened at zero is already at
    -- version 1, so its first entry is sequence 2.
    select wallet_id, 'CHAIN', id::text
      from chained
     where (position = 1 and (balance_before <> 0 or sequence not in (1, 2)))
        or (position > 1 and (balance_before <> previous_after or sequence <> previous_sequence + 1))
    union all
    select t.wallet_id, 'MISSING_ENTRY', t.id::text
      from expected t
     where (select count(*) from wallet_ledger_entries e
             where e.transaction_id = t.id and e.wallet_id = t.wallet_id
               and e.amount = t.amount and e.currency = t.currency
               and e.direction = t.expected_direction) <> 1
    union all
    select e.wallet_id, 'UNEXPECTED_ENTRY', e.id::text
      from wallet_ledger_entries e
      join wager_transactions t on t.id = e.transaction_id
     where t.status <> 'PROCESSED' or t.kind = 'LOSS'
  `;
}

/** Final assertion of every integration and concurrency test (CLAUDE.md, invariant 7). */
export async function expectLedgerInvariant(sql: SQL): Promise<void> {
  expect(await findLedgerProblems(sql)).toEqual([]);
}

/**
 * The same assertion for suites that hold no client of their own (health, correlation, migration
 * runner): opens one on the migrated suite database, asserts, closes it.
 */
export async function expectLedgerInvariantOnSuiteDatabase(): Promise<void> {
  const sql = await migratedDatabase();
  try {
    await expectLedgerInvariant(sql);
  } finally {
    await sql.close();
  }
}
