import type { SQL } from 'bun';

/**
 * Raw rows for the schema tests. Each builder returns a row that every constraint accepts, with
 * fresh ids, so a test changes exactly the field it is about. Rows go through SQL on purpose:
 * these tests prove what the database refuses on its own, without the domain in front of it.
 */
export type Row = Record<string, unknown>;

export const newId = (): string => Bun.randomUUIDv7();
export const AT = new Date('2026-11-13T12:00:00.000Z');
const HASH = 'ab'.repeat(32);

export function walletRow(overrides: Row = {}): Row {
  return {
    id: newId(),
    player_id: `player-${newId()}`,
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

export function accountRow(overrides: Row = {}): Row {
  return {
    id: newId(),
    kind: 'PROVIDER_SETTLEMENT',
    provider_id: `provider-${newId()}`,
    currency: 'BRL',
    created_at: AT,
    ...overrides,
  };
}

/**
 * A processed `BET` of 10.00 on `wallet`, with no reference. An `OPENING` defaults to the `SYSTEM`
 * provider, the only one the schema allows for it.
 */
export function transactionRow(wallet: Row, overrides: Row = {}): Row {
  return {
    id: newId(),
    provider_id: overrides.kind === 'OPENING' ? 'SYSTEM' : 'provider-a',
    external_transaction_id: `ext-${newId()}`,
    idempotency_key: `key-${newId()}`,
    payload_hash: HASH,
    wallet_id: wallet.id,
    player_id: wallet.player_id,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: wallet.currency,
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    observed_balance: '0.00',
    observed_currency: wallet.currency,
    processed_at: AT,
    created_at: AT,
    ...overrides,
  };
}

export function entryRow(overrides: Row = {}): Row {
  return {
    id: newId(),
    direction: 'CREDIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '0.00',
    balance_after: '10.00',
    sequence: 1,
    created_at: AT,
    ...overrides,
  };
}

export async function insertWallet(sql: SQL, row: Row = walletRow()): Promise<Row> {
  await sql`insert into wallets ${sql(row)}`;
  return row;
}

export async function insertAccount(sql: SQL, row: Row = accountRow()): Promise<Row> {
  await sql`insert into ledger_accounts ${sql(row)}`;
  return row;
}

export async function insertTransaction(sql: SQL, row: Row): Promise<Row> {
  await sql`insert into wager_transactions ${sql(row)}`;
  return row;
}

export async function insertEntry(sql: SQL, row: Row): Promise<Row> {
  await sql`insert into wallet_ledger_entries ${sql(row)}`;
  return row;
}

/**
 * A currency code with no `FUNDING` account yet. The suite database outlives a run, so a test
 * about the first account of a currency cannot use a fixed code.
 */
export async function unusedCurrency(sql: SQL): Promise<string> {
  for (;;) {
    const code = Array.from({ length: 3 }, () =>
      String.fromCharCode(65 + Math.floor(Math.random() * 26)),
    ).join('');
    const [row] =
      await sql`select count(*)::int as n from ledger_accounts where currency = ${code}`;
    if (row.n === 0) return code;
  }
}

/** The `FUNDING` account of `currency`, created on first use as ADR-12 describes. */
export async function fundingAccountId(sql: SQL, currency = 'BRL'): Promise<string> {
  await sql`
    insert into ledger_accounts (id, kind, provider_id, currency, created_at)
    values (${newId()}, 'FUNDING', null, ${currency}, ${AT})
    on conflict do nothing`;
  const [row] = await sql`
    select id from ledger_accounts
     where kind = 'FUNDING' and provider_id is null and currency = ${currency}`;
  return row.id;
}

export interface SeededWallet {
  wallet: Row;
  fundingAccountId: string;
  /** The `OPENING` transaction, when the balance is positive. */
  opening: Row | undefined;
}

/**
 * A wallet opened the way S1 opens one: version 1, and for a positive balance an `OPENING`
 * transaction with one `CREDIT` entry at sequence 1, posted against `FUNDING`. Consistent with
 * its ledger, so the ledger invariant holds after it.
 */
export async function seedWallet(sql: SQL, balance = '100.00'): Promise<SeededWallet> {
  const funding = await fundingAccountId(sql);
  const wallet = walletRow({ balance });
  if (balance === '0.00') {
    await insertWallet(sql, wallet);
    return { wallet, fundingAccountId: funding, opening: undefined };
  }
  const opening = transactionRow(wallet, {
    provider_id: 'SYSTEM',
    kind: 'OPENING',
    amount: balance,
    observed_balance: balance,
  });
  await sql.begin(async (tx) => {
    await insertWallet(tx, wallet);
    await insertTransaction(tx, opening);
    await insertEntry(
      tx,
      entryRow({
        wallet_id: wallet.id,
        transaction_id: opening.id,
        counterparty_account_id: funding,
        amount: balance,
        balance_after: balance,
      }),
    );
  });
  return { wallet, fundingAccountId: funding, opening };
}

/** The settlement account of `providerId` in `currency`, created on first use (ADR-12). */
export async function settlementAccountId(
  sql: SQL,
  providerId: string,
  currency = 'BRL',
): Promise<string> {
  await sql`
    insert into ledger_accounts (id, kind, provider_id, currency, created_at)
    values (${newId()}, 'PROVIDER_SETTLEMENT', ${providerId}, ${currency}, ${AT})
    on conflict do nothing`;
  const [row] = await sql`
    select id from ledger_accounts
     where kind = 'PROVIDER_SETTLEMENT' and provider_id = ${providerId} and currency = ${currency}`;
  return row.id;
}

/**
 * Inserts `row` and, when it moves money (`PROCESSED` and not `LOSS`), its entry and the new
 * wallet balance and version, in one SQL transaction under the wallet lock: what the use case of
 * S4 will do, so the ledger invariant holds after it. PostgreSQL computes the balance, never JS.
 * `BET` debits, `ROLLBACK` inverts its reference's entry, every other kind credits.
 */
export async function applyTransaction(sql: SQL, row: Row): Promise<Row> {
  await sql.begin(async (tx) => {
    await insertTransaction(tx, row);
    if (row.status !== 'PROCESSED' || row.kind === 'LOSS') return;

    const currency = row.currency as string;
    const account =
      row.kind === 'OPENING'
        ? await fundingAccountId(tx, currency)
        : await settlementAccountId(tx, row.provider_id as string, currency);
    let direction = row.kind === 'BET' ? 'DEBIT' : 'CREDIT';
    if (row.kind === 'ROLLBACK') {
      const [reference] = await tx`
        select direction from wallet_ledger_entries
         where transaction_id = ${row.reference_transaction_id}`;
      direction = reference.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';
    }

    const entryId = newId();
    await tx`select id from wallets where id = ${row.wallet_id} for update`;
    await tx`
      insert into wallet_ledger_entries (id, wallet_id, transaction_id, counterparty_account_id,
                                         direction, amount, currency, balance_before,
                                         balance_after, sequence, created_at)
      select ${entryId}, w.id, ${row.id}, ${account}, ${direction}, ${row.amount}::numeric,
             w.currency, w.balance,
             case ${direction}::text
               when 'CREDIT' then w.balance + ${row.amount}::numeric
               else w.balance - ${row.amount}::numeric
             end,
             w.version + 1, ${AT}
        from wallets w
       where w.id = ${row.wallet_id}`;
    await tx`
      update wallets w set balance = e.balance_after, version = e.sequence, updated_at = ${AT}
        from wallet_ledger_entries e
       where e.id = ${entryId} and w.id = e.wallet_id`;
  });
  return row;
}
