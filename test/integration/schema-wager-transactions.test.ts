import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { FailureCode } from '../../src/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import {
  expectRefused,
  inRolledBackTransaction,
  migratedDatabase,
  SqlState,
} from '../support/database';
import { expectLedgerInvariant } from '../support/ledger-invariant';
import {
  applyTransaction,
  insertTransaction,
  newId,
  type Row,
  seedWallet,
  transactionRow,
} from '../support/schema-fixtures';

let sql: SQL;
let wallet: Row;

beforeAll(async () => {
  sql = await migratedDatabase();
  // Large enough that no BET of these tests can overdraw it.
  ({ wallet } = await seedWallet(sql, '1000000.00'));
});

afterEach(async () => {
  await expectLedgerInvariant(sql);
});

afterAll(async () => {
  await sql.close();
});

/** A processed `BET` of 10.00. Committed through `apply`, so its entry exists. */
const row = (overrides: Row = {}): Row => transactionRow(wallet, overrides);
const apply = (transaction: Row) => applyTransaction(sql, transaction);
const rejected = (overrides: Row = {}): Row =>
  row({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null, ...overrides });

/** A `WIN` that declared a reference which has not arrived yet. */
const pendingReference = (overrides: Row = {}): Row =>
  row({
    kind: 'WIN',
    reference_external_transaction_id: `ext-${newId()}`,
    status: 'PENDING_REFERENCE',
    processed_at: null,
    next_attempt_at: new Date(),
    ...overrides,
  });

/** A processed reversal of `reference`, resolved. */
const reversalOf = (reference: Row, kind: string, overrides: Row = {}): Row =>
  row({
    kind,
    amount: reference.amount,
    reference_external_transaction_id: reference.external_transaction_id,
    reference_transaction_id: reference.id,
    ...overrides,
  });

const check = (constraint: string) => ({ sqlState: SqlState.checkViolation, constraint });
const raised = (message: RegExp) => ({ sqlState: SqlState.raiseException, message });

describe('wager_transactions uniqueness', () => {
  test('refuses a second transaction with the same idempotency key', async () => {
    const first = await apply(row());

    await expectRefused(
      insertTransaction(sql, rejected({ idempotency_key: first.idempotency_key })),
      {
        sqlState: SqlState.uniqueViolation,
        constraint: 'wager_transactions_idempotency_key_key',
      },
    );
  });

  test('refuses a second transaction with the same provider and external id', async () => {
    const first = await apply(row());

    await expectRefused(
      insertTransaction(sql, rejected({ external_transaction_id: first.external_transaction_id })),
      {
        sqlState: SqlState.uniqueViolation,
        constraint: 'wager_transactions_provider_external_key',
      },
    );
    await apply(
      row({ provider_id: 'provider-b', external_transaction_id: first.external_transaction_id }),
    );
  });

  test('refuses a second processed reversal of the same reference, of any kind', async () => {
    const bet = await apply(row());
    await apply(reversalOf(bet, 'REFUND'));

    for (const kind of ['ROLLBACK', 'REFUND']) {
      await expectRefused(apply(reversalOf(bet, kind)), {
        sqlState: SqlState.uniqueViolation,
        constraint: 'wager_transactions_single_reversal',
      });
    }
  });

  test('allows a rejected reversal next to a processed one', async () => {
    const bet = await apply(row());
    await apply(reversalOf(bet, 'REFUND'));

    await insertTransaction(
      sql,
      reversalOf(bet, 'ROLLBACK', {
        status: 'REJECTED',
        failure_code: 'REFERENCE_ALREADY_REVERSED',
        processed_at: null,
      }),
    );
    const [counted] = await sql`
      select count(*)::int as n from wager_transactions where reference_transaction_id = ${bet.id}`;
    expect(counted.n).toBe(2);
  });

  test('refuses a transaction for an unknown wallet', async () => {
    await expectRefused(insertTransaction(sql, rejected({ wallet_id: newId() })), {
      sqlState: SqlState.foreignKeyViolation,
      constraint: 'wager_transactions_wallet_fk',
    });
  });

  test('refuses a reference to an unknown transaction or to one of another wallet', async () => {
    await expectRefused(
      insertTransaction(
        sql,
        rejected({
          kind: 'WIN',
          reference_external_transaction_id: `ext-${newId()}`,
          reference_transaction_id: newId(),
        }),
      ),
      { sqlState: SqlState.foreignKeyViolation, constraint: 'wager_transactions_reference_fk' },
    );

    const other = await seedWallet(sql, '100.00');
    const foreignBet = await apply(transactionRow(other.wallet));
    await expectRefused(apply(reversalOf(foreignBet, 'REFUND')), {
      sqlState: SqlState.foreignKeyViolation,
      constraint: 'wager_transactions_reference_fk',
    });
    // A mismatch rejection keeps the reference unresolved, which the foreign key lets through.
    await insertTransaction(
      sql,
      reversalOf(foreignBet, 'REFUND', {
        reference_transaction_id: null,
        status: 'REJECTED',
        failure_code: 'REFERENCE_MISMATCH',
        processed_at: null,
      }),
    );
  });

  test('the pending-reference scan is served by its partial index', async () => {
    await insertTransaction(sql, pendingReference());

    const plan = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return tx`
        explain select id from wager_transactions
         where status = 'PENDING_REFERENCE' and next_attempt_at <= now()
         order by next_attempt_at limit 10`;
    });
    expect(JSON.stringify(plan)).toContain('wager_transactions_pending_reference_due');
  });
});

describe('wager_transactions checks', () => {
  test('accepts every kind, committed status and failure code of the domain', async () => {
    for (const kind of Object.values(WagerTransactionKind)) {
      if (kind === 'REFUND' || kind === 'ROLLBACK') {
        await insertTransaction(sql, pendingReference({ kind }));
      } else {
        await apply(row({ kind }));
      }
    }
    const byStatus: Record<Exclude<WagerTransactionStatus, 'PENDING'>, Row> = {
      PENDING_REFERENCE: pendingReference(),
      PROCESSED: row(),
      REJECTED: rejected(),
      FAILED: row({ status: 'FAILED', failure_code: 'PROCESSING_FAILED', processed_at: null }),
    };
    for (const transaction of Object.values(byStatus)) {
      await apply(transaction);
    }
    for (const code of Object.values(FailureCode)) {
      const status = code === FailureCode.ProcessingFailed ? 'FAILED' : 'REJECTED';
      await insertTransaction(sql, rejected({ status, failure_code: code }));
    }

    await expectRefused(
      insertTransaction(sql, rejected({ kind: 'TIP' })),
      check('wager_transactions_kind_valid'),
    );
    await expectRefused(
      insertTransaction(sql, rejected({ status: 'DONE', failure_code: null })),
      check('wager_transactions_status_valid'),
    );
    await expectRefused(
      insertTransaction(sql, rejected({ failure_code: 'OOPS' })),
      check('wager_transactions_failure_code_valid'),
    );
  });

  test('PENDING is never committed (L-06)', async () => {
    await expectRefused(
      insertTransaction(
        sql,
        row({
          status: 'PENDING',
          observed_balance: null,
          observed_currency: null,
          processed_at: null,
        }),
      ),
      check('wager_transactions_status_valid'),
    );
  });

  test('refuses empty identifiers and malformed hash and currencies', async () => {
    const refused: [Row, string][] = [
      [{ provider_id: '' }, 'wager_transactions_provider_id_not_empty'],
      [{ external_transaction_id: '' }, 'wager_transactions_external_transaction_id_not_empty'],
      [{ idempotency_key: '' }, 'wager_transactions_idempotency_key_not_empty'],
      [{ payload_hash: 'AB'.repeat(32) }, 'wager_transactions_payload_hash_format'],
      [{ payload_hash: `${'ab'.repeat(31)}zz` }, 'wager_transactions_payload_hash_format'],
      [{ currency: 'usd' }, 'wager_transactions_currency_format'],
      [{ observed_currency: 'R$ ' }, 'wager_transactions_observed_currency_format'],
      [{ reference_attempts: -1 }, 'wager_transactions_reference_attempts_non_negative'],
    ];
    for (const [overrides, constraint] of refused) {
      await expectRefused(insertTransaction(sql, rejected(overrides)), check(constraint));
    }
  });

  test('refuses a reversal without a reference and a BET or OPENING with one', async () => {
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectRefused(
        insertTransaction(sql, rejected({ kind })),
        check('wager_transactions_reference_by_kind'),
      );
    }
    for (const kind of ['BET', 'OPENING']) {
      await expectRefused(
        insertTransaction(sql, pendingReference({ kind })),
        check('wager_transactions_reference_by_kind'),
      );
    }
    await insertTransaction(sql, pendingReference({ kind: 'LOSS', amount: '0.00' }));
  });

  test('SYSTEM is reserved for OPENING, and OPENING belongs to SYSTEM', async () => {
    // The identity of the internal opening is not a provider's to claim (S3 review, M1).
    for (const kind of ['BET', 'WIN', 'LOSS']) {
      await expectRefused(
        insertTransaction(sql, rejected({ kind, provider_id: 'SYSTEM' })),
        check('wager_transactions_system_provider_only_for_opening'),
      );
    }
    await expectRefused(
      insertTransaction(sql, rejected({ kind: 'OPENING', provider_id: 'provider-a' })),
      check('wager_transactions_system_provider_only_for_opening'),
    );
    await insertTransaction(sql, rejected({ kind: 'OPENING', provider_id: 'SYSTEM' }));
  });

  test('refuses a self-reference', async () => {
    const externalId = `ext-${newId()}`;
    await expectRefused(
      insertTransaction(
        sql,
        pendingReference({
          external_transaction_id: externalId,
          reference_external_transaction_id: externalId,
        }),
      ),
      check('wager_transactions_no_self_reference'),
    );

    const id = newId();
    await expectRefused(
      insertTransaction(
        sql,
        rejected({
          id,
          kind: 'WIN',
          reference_external_transaction_id: `ext-${newId()}`,
          reference_transaction_id: id,
        }),
      ),
      check('wager_transactions_no_self_reference'),
    );
  });

  test('refuses a zero amount except for LOSS', async () => {
    for (const kind of ['BET', 'WIN', 'OPENING']) {
      await expectRefused(
        insertTransaction(sql, rejected({ kind, amount: '0.00' })),
        check('wager_transactions_amount_positive'),
      );
    }
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectRefused(
        insertTransaction(sql, pendingReference({ kind, amount: '0.00' })),
        check('wager_transactions_amount_positive'),
      );
    }
    await expectRefused(
      insertTransaction(sql, row({ kind: 'LOSS', amount: '-1.00' })),
      check('wager_transactions_amount_positive'),
    );
    await apply(row({ kind: 'LOSS', amount: '0.00' }));
  });

  test('pairs status and failure code as in ARCHITECTURE §6', async () => {
    const refused: Row[] = [
      rejected({ failure_code: null }),
      rejected({ failure_code: 'PROCESSING_FAILED' }),
      rejected({ status: 'FAILED', failure_code: null }),
      rejected({ status: 'FAILED', failure_code: 'INSUFFICIENT_FUNDS' }),
      row({ failure_code: 'INSUFFICIENT_FUNDS' }),
      pendingReference({ failure_code: 'REFERENCE_NOT_FOUND' }),
    ];
    for (const transaction of refused) {
      await expectRefused(
        insertTransaction(sql, transaction),
        check('wager_transactions_failure_code_by_status'),
      );
    }
  });

  test('requires the observed balance once a status is reached and processedAt exactly when PROCESSED', async () => {
    const refused: [Row, string][] = [
      [row({ observed_balance: null, observed_currency: null }), 'observed_balance_by_status'],
      [
        pendingReference({ observed_balance: null, observed_currency: null }),
        'observed_balance_by_status',
      ],
      [row({ observed_currency: null }), 'observed_balance_complete'],
      [row({ observed_balance: '-1.00' }), 'observed_balance_non_negative'],
      [row({ processed_at: null }), 'processed_at_by_status'],
      [rejected({ processed_at: new Date() }), 'processed_at_by_status'],
    ];
    for (const [transaction, constraint] of refused) {
      await expectRefused(
        insertTransaction(sql, transaction),
        check(`wager_transactions_${constraint}`),
      );
    }
    // FAILED keeps whatever was observed before, including nothing.
    await insertTransaction(
      sql,
      rejected({
        status: 'FAILED',
        failure_code: 'PROCESSING_FAILED',
        observed_balance: null,
        observed_currency: null,
      }),
    );
    // A CURRENCY_MISMATCH rejection observes the wallet balance in the wallet's currency.
    await insertTransaction(
      sql,
      rejected({ currency: 'USD', failure_code: 'CURRENCY_MISMATCH', observed_currency: 'BRL' }),
    );
  });

  test('a pending-reference row is always due and never holds a resolved reference', async () => {
    await expectRefused(
      insertTransaction(sql, pendingReference({ next_attempt_at: null })),
      check('wager_transactions_next_attempt_when_pending'),
    );

    const bet = await apply(row());
    await expectRefused(
      insertTransaction(
        sql,
        pendingReference({
          reference_external_transaction_id: bet.external_transaction_id,
          reference_transaction_id: bet.id,
        }),
      ),
      check('wager_transactions_unresolved_while_pending'),
    );
  });

  test('a processed transaction with a declared reference has it resolved', async () => {
    await expectRefused(
      insertTransaction(
        sql,
        row({ kind: 'WIN', reference_external_transaction_id: `ext-${newId()}` }),
      ),
      check('wager_transactions_reference_resolved_when_processed'),
    );

    const bet = await apply(row());
    await expectRefused(
      insertTransaction(sql, row({ kind: 'WIN', reference_transaction_id: bet.id })),
      check('wager_transactions_reference_resolved_only_if_declared'),
    );
    await apply(reversalOf(bet, 'WIN'));
  });
});

describe('wager_transactions immutability', () => {
  test('a terminal row cannot be updated', async () => {
    const terminal = [
      row(),
      rejected(),
      row({ status: 'FAILED', failure_code: 'PROCESSING_FAILED', processed_at: null }),
    ];
    for (const transaction of terminal) {
      await apply(transaction);
      await expectRefused(
        sql`update wager_transactions set reference_attempts = 1 where id = ${transaction.id}`,
        raised(/is (PROCESSED|REJECTED|FAILED) and cannot change/),
      );
    }
  });

  test('no identity column of a pending-reference row can change', async () => {
    const waiting = await insertTransaction(sql, pendingReference());
    const changes: Row = {
      id: newId(),
      provider_id: 'provider-z',
      external_transaction_id: 'ext-z',
      idempotency_key: 'key-z',
      payload_hash: 'cd'.repeat(32),
      wallet_id: newId(),
      player_id: 'player-z',
      round_id: 'round-z',
      game_id: 'game-z',
      kind: 'LOSS',
      amount: '11.00',
      currency: 'USD',
      reference_external_transaction_id: 'ext-y',
      created_at: new Date(0),
    };
    for (const [column, value] of Object.entries(changes)) {
      await expectRefused(
        sql`update wager_transactions set ${sql({ [column]: value })} where id = ${waiting.id}`,
        raised(/identity of wager transaction .* cannot change/),
      );
    }
  });

  test('the correlation id of a row cannot change once written (S7 review, m1)', async () => {
    // The worker's events carry it (L-15). Refused by its own trigger on forbid_change().
    const waiting = await insertTransaction(sql, pendingReference({ correlation_id: 'corr-a' }));
    const unset = await insertTransaction(sql, pendingReference());

    for (const [id, value] of [
      [waiting.id, 'corr-z'],
      [waiting.id, null],
      [unset.id, 'corr-z'],
    ]) {
      await expectRefused(
        sql`update wager_transactions set correlation_id = ${value} where id = ${id}`,
        raised(/UPDATE on wager_transactions is not allowed/),
      );
    }
    // Rewriting the same value is not a change.
    await sql`update wager_transactions set correlation_id = 'corr-a' where id = ${waiting.id}`;
  });

  test('an empty correlation id is refused (S7 review, m1)', async () => {
    await expectRefused(
      insertTransaction(sql, pendingReference({ correlation_id: '' })),
      check('wager_transactions_correlation_id_not_empty'),
    );
  });

  test('a pending-reference row only leaves for a terminal status, and FAILED keeps the observed balance', async () => {
    const waiting = await insertTransaction(sql, pendingReference());

    await expectRefused(
      sql`
        update wager_transactions
           set status = 'PENDING', observed_balance = null, observed_currency = null
         where id = ${waiting.id}`,
      raised(/cannot move from PENDING_REFERENCE to PENDING/),
    );
    await expectRefused(
      sql`
        update wager_transactions
           set status = 'FAILED', failure_code = 'PROCESSING_FAILED',
               observed_balance = null, observed_currency = null
         where id = ${waiting.id}`,
      raised(/keeps its observed balance when it fails/),
    );

    await sql`
      update wager_transactions set reference_attempts = 1, next_attempt_at = now()
       where id = ${waiting.id}`;
    await sql`
      update wager_transactions set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND'
       where id = ${waiting.id}`;
    const [stored] = await sql`
      select status, failure_code, reference_attempts from wager_transactions where id = ${waiting.id}`;
    expect(stored).toEqual({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: 1,
    });
  });

  test('no row can be deleted or truncated', async () => {
    const pending = await insertTransaction(sql, pendingReference());
    const processed = await apply(row());

    for (const id of [pending.id, processed.id]) {
      await expectRefused(
        sql`delete from wager_transactions where id = ${id}`,
        raised(/DELETE on wager_transactions is not allowed/),
      );
    }
    // The ledger's own truncate trigger is disabled inside a rolled-back transaction, so only the
    // trigger of wager_transactions can refuse this cascade.
    await inRolledBackTransaction(sql, async (tx) => {
      await tx`alter table wallet_ledger_entries disable trigger wallet_ledger_entries_forbid_truncate`;
      await expectRefused(
        tx`truncate wager_transactions cascade`,
        raised(/TRUNCATE on wager_transactions is not allowed/),
      );
    });
    const [counted] = await sql`
      select count(*)::int as n from wager_transactions where id in (${pending.id}, ${processed.id})`;
    expect(counted.n).toBe(2);
  });
});
