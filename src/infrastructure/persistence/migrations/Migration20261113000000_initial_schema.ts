import { Migration } from '@mikro-orm/migrations';

/**
 * The whole schema of ARCHITECTURE §3. Every guarantee the statement asks the database to hold
 * (uniqueness, immutability, non-negativity) is a named constraint, index or trigger here, so a
 * violation fails at the database even if the code in front of it is wrong.
 *
 * Conventions: money is `NUMERIC(19,2)` next to a `CHAR(3)` currency (ADR-02); kinds, statuses and
 * failure codes are `TEXT` with a `CHECK` listing the domain values, which is simpler to evolve
 * than an enum type; times come from the application clock, so no column has a time default.
 */
const UP = [
  // Raised by every trigger that forbids a change. TG_OP and TG_TABLE_NAME name what was refused.
  `create function forbid_change() returns trigger language plpgsql as $$
   begin
     raise exception '% on % is not allowed', tg_op, tg_table_name;
   end
   $$`,

  // ADR-12: system accounts only. No balance column, never locked: their balance is an aggregate
  // over the ledger, so no row is shared by every wallet.
  `create table ledger_accounts (
     id uuid primary key,
     kind text not null
       constraint ledger_accounts_kind_valid check (kind in ('FUNDING', 'PROVIDER_SETTLEMENT')),
     provider_id text
       constraint ledger_accounts_provider_id_not_empty check (provider_id <> ''),
     currency char(3) not null
       constraint ledger_accounts_currency_format check (currency ~ '^[A-Z]{3}$'),
     created_at timestamptz not null,
     constraint ledger_accounts_provider_only_for_settlement
       check ((kind = 'PROVIDER_SETTLEMENT') = (provider_id is not null)),
     constraint ledger_accounts_kind_provider_currency_key
       unique nulls not distinct (kind, provider_id, currency),
     -- Target of the composite foreign key that makes an entry's currency the account's.
     constraint ledger_accounts_id_currency_key unique (id, currency)
   )`,

  `create table wallets (
     id uuid primary key,
     player_id text not null
       constraint wallets_player_id_not_empty check (player_id <> ''),
     currency char(3) not null
       constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
     balance numeric(19, 2) not null
       constraint wallets_balance_non_negative check (balance >= 0),
     version integer not null
       constraint wallets_version_positive check (version >= 1),
     created_at timestamptz not null,
     updated_at timestamptz not null,
     constraint wallets_player_currency_key unique (player_id, currency),
     -- Target of the composite foreign key that makes an entry's currency the wallet's.
     constraint wallets_id_currency_key unique (id, currency)
   )`,

  // The transaction row is also the idempotency record (ADR-03).
  `create table wager_transactions (
     id uuid primary key,
     provider_id text not null
       constraint wager_transactions_provider_id_not_empty check (provider_id <> ''),
     external_transaction_id text not null
       constraint wager_transactions_external_transaction_id_not_empty
       check (external_transaction_id <> ''),
     idempotency_key text not null
       constraint wager_transactions_idempotency_key_not_empty check (idempotency_key <> ''),
     payload_hash char(64) not null
       constraint wager_transactions_payload_hash_format check (payload_hash ~ '^[0-9a-f]{64}$'),
     -- L-08: a transaction for an unknown wallet is never persisted.
     wallet_id uuid not null
       constraint wager_transactions_wallet_fk references wallets (id),
     player_id text not null,
     round_id text not null,
     game_id text not null,
     kind text not null
       constraint wager_transactions_kind_valid
       check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
     amount numeric(19, 2) not null,
     -- Not tied to the wallet: a CURRENCY_MISMATCH rejection is persisted with its own currency.
     currency char(3) not null
       constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
     reference_external_transaction_id text,
     reference_transaction_id uuid,
     -- L-06: PENDING is the in-memory initial state and is never committed.
     status text not null
       constraint wager_transactions_status_valid
       check (status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
     failure_code text
       constraint wager_transactions_failure_code_valid
       check (failure_code in (
         'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'CURRENCY_MISMATCH',
         'WALLET_PLAYER_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH',
         'REFERENCE_KIND_NOT_ALLOWED', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_AMOUNT_MISMATCH',
         'REFERENCE_ALREADY_REVERSED', 'PROCESSING_FAILED')),
     -- The wallet balance seen when the status was reached, in the wallet's currency (ADR-03).
     observed_balance numeric(19, 2)
       constraint wager_transactions_observed_balance_non_negative check (observed_balance >= 0),
     observed_currency char(3)
       constraint wager_transactions_observed_currency_format
       check (observed_currency ~ '^[A-Z]{3}$'),
     processed_at timestamptz,
     -- Pending-reference bookkeeping of the worker (ADR-05).
     reference_attempts integer not null default 0
       constraint wager_transactions_reference_attempts_non_negative
       check (reference_attempts >= 0),
     next_attempt_at timestamptz,
     created_at timestamptz not null,

     -- L-03: a movement is positive; only LOSS may be zero.
     constraint wager_transactions_amount_positive
       check (amount > 0 or (kind = 'LOSS' and amount = 0)),
     -- L-18: REFUND and ROLLBACK require a reference; BET and OPENING refuse one.
     constraint wager_transactions_reference_by_kind check (
       case
         when kind in ('REFUND', 'ROLLBACK') then reference_external_transaction_id is not null
         when kind in ('BET', 'OPENING') then reference_external_transaction_id is null
         else true
       end),
     constraint wager_transactions_no_self_reference check (
       reference_external_transaction_id <> external_transaction_id
       and reference_transaction_id <> id),
     -- A reference can only be resolved if one was declared, and a processed transaction that
     -- declared one has it resolved: the single-reversal index below relies on it.
     constraint wager_transactions_reference_resolved_only_if_declared
       check (reference_transaction_id is null or reference_external_transaction_id is not null),
     constraint wager_transactions_reference_resolved_when_processed check (
       status <> 'PROCESSED'
       or (reference_transaction_id is null) = (reference_external_transaction_id is null)),
     -- ARCHITECTURE §6: REJECTED carries a business code, FAILED carries PROCESSING_FAILED,
     -- every other status carries none.
     constraint wager_transactions_failure_code_by_status check (
       case status
         when 'REJECTED' then failure_code is not null and failure_code <> 'PROCESSING_FAILED'
         when 'FAILED' then failure_code is not distinct from 'PROCESSING_FAILED'
         else failure_code is null
       end),
     constraint wager_transactions_observed_balance_complete
       check ((observed_balance is null) = (observed_currency is null)),
     constraint wager_transactions_observed_balance_by_status check (
       status not in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED')
       or observed_balance is not null),
     constraint wager_transactions_processed_at_by_status
       check ((status = 'PROCESSED') = (processed_at is not null)),
     -- A waiting row is always due at some time, or the worker's scan would never find it.
     constraint wager_transactions_next_attempt_when_pending
       check (status <> 'PENDING_REFERENCE' or next_attempt_at is not null),
     -- A resolved reference moves the row out of PENDING_REFERENCE in the same statement.
     constraint wager_transactions_unresolved_while_pending
       check (status <> 'PENDING_REFERENCE' or reference_transaction_id is null),

     constraint wager_transactions_idempotency_key_key unique (idempotency_key),
     constraint wager_transactions_provider_external_key
       unique (provider_id, external_transaction_id),
     -- Target of the composite foreign key that ties an entry to its transaction's wallet.
     constraint wager_transactions_id_wallet_key unique (id, wallet_id),
     -- Rule 7.2: a reference belongs to the same wallet, which is what lets one wallet lock
     -- cover both rows (ARCHITECTURE §2). MATCH SIMPLE: an unresolved reference (NULL) passes.
     constraint wager_transactions_reference_fk
       foreign key (reference_transaction_id, wallet_id)
       references wager_transactions (id, wallet_id)
   )`,

  // L-01: at most one processed reversal per reference, of any kind.
  `create unique index wager_transactions_single_reversal
     on wager_transactions (reference_transaction_id)
     where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`,

  // Scan of the pending-reference worker (ADR-05).
  `create index wager_transactions_pending_reference_due
     on wager_transactions (next_attempt_at)
     where status = 'PENDING_REFERENCE'`,

  // A terminal row never changes; a pending-reference row may reach a status but its identity,
  // which the payload hash covers, never changes.
  `create function wager_transactions_guard_update() returns trigger language plpgsql as $$
   begin
     if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
       raise exception 'wager transaction % is % and cannot change', old.id, old.status;
     end if;
     if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
         new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind,
         new.amount, new.currency, new.reference_external_transaction_id, new.created_at)
        is distinct from
        (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
         old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind,
         old.amount, old.currency, old.reference_external_transaction_id, old.created_at) then
       raise exception 'the identity of wager transaction % cannot change', old.id;
     end if;
     -- ARCHITECTURE §5: the only committed non-terminal status leaves only for a terminal one.
     if new.status <> old.status and new.status not in ('PROCESSED', 'REJECTED', 'FAILED') then
       raise exception 'wager transaction % cannot move from % to %', old.id, old.status, new.status;
     end if;
     -- fail() keeps the balance observed before it.
     if new.status = 'FAILED'
        and (new.observed_balance, new.observed_currency)
            is distinct from (old.observed_balance, old.observed_currency) then
       raise exception 'wager transaction % keeps its observed balance when it fails', old.id;
     end if;
     return new;
   end
   $$`,

  `create trigger wager_transactions_guard_update
     before update on wager_transactions
     for each row execute function wager_transactions_guard_update()`,

  `create trigger wager_transactions_forbid_delete
     before delete on wager_transactions
     for each row execute function forbid_change()`,

  `create trigger wager_transactions_forbid_truncate
     before truncate on wager_transactions
     for each statement execute function forbid_change()`,

  // One row is one balanced posting between the wallet and a system account (ADR-12).
  `create table wallet_ledger_entries (
     id uuid primary key,
     wallet_id uuid not null,
     transaction_id uuid not null,
     counterparty_account_id uuid not null,
     direction text not null
       constraint wallet_ledger_entries_direction_valid check (direction in ('DEBIT', 'CREDIT')),
     amount numeric(19, 2) not null
       constraint wallet_ledger_entries_amount_positive check (amount > 0),
     currency char(3) not null,
     balance_before numeric(19, 2) not null
       constraint wallet_ledger_entries_balance_before_non_negative check (balance_before >= 0),
     balance_after numeric(19, 2) not null
       constraint wallet_ledger_entries_balance_after_non_negative check (balance_after >= 0),
     -- The wallet version this entry produced.
     sequence integer not null
       constraint wallet_ledger_entries_sequence_positive check (sequence >= 1),
     created_at timestamptz not null,
     constraint wallet_ledger_entries_arithmetic check (
       balance_after = case direction
         when 'CREDIT' then balance_before + amount
         else balance_before - amount
       end),
     constraint wallet_ledger_entries_transaction_wallet_key unique (transaction_id, wallet_id),
     -- A lost update would write a second entry for the same version: it cannot be recorded.
     constraint wallet_ledger_entries_wallet_sequence_key unique (wallet_id, sequence),
     constraint wallet_ledger_entries_wallet_fk
       foreign key (wallet_id, currency) references wallets (id, currency),
     constraint wallet_ledger_entries_transaction_fk
       foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
     constraint wallet_ledger_entries_counterparty_fk
       foreign key (counterparty_account_id, currency) references ledger_accounts (id, currency)
   )`,

  // Append-only (R-09).
  `create trigger wallet_ledger_entries_forbid_update_delete
     before update or delete on wallet_ledger_entries
     for each row execute function forbid_change()`,

  `create trigger wallet_ledger_entries_forbid_truncate
     before truncate on wallet_ledger_entries
     for each statement execute function forbid_change()`,

  `create table inbox_messages (
     consumer_name text not null,
     message_id text not null,
     payload_hash char(64) not null,
     received_at timestamptz not null,
     processed_at timestamptz,
     constraint inbox_messages_pkey primary key (consumer_name, message_id)
   )`,

  // The id is the event id. next_attempt_at starts at occurred_at, so the publisher's scan needs
  // no "or is null" branch.
  `create table outbox_messages (
     id uuid primary key,
     aggregate_id uuid not null,
     event_type text not null,
     payload jsonb not null,
     occurred_at timestamptz not null,
     attempts integer not null default 0
       constraint outbox_messages_attempts_non_negative check (attempts >= 0),
     next_attempt_at timestamptz not null,
     published_at timestamptz
   )`,

  `create index outbox_messages_pending
     on outbox_messages (next_attempt_at)
     where published_at is null`,
];

const DOWN = [
  'drop table outbox_messages',
  'drop table inbox_messages',
  'drop table wallet_ledger_entries',
  'drop table wager_transactions',
  'drop function wager_transactions_guard_update()',
  'drop table wallets',
  'drop table ledger_accounts',
  'drop function forbid_change()',
];

export class Migration20261113000000_initial_schema extends Migration {
  override up(): void {
    for (const statement of UP) {
      this.addSql(statement);
    }
  }

  override down(): void {
    for (const statement of DOWN) {
      this.addSql(statement);
    }
  }
}
