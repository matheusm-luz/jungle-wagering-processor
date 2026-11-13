import { Migration } from '@mikro-orm/migrations';

/** The guard of the initial schema, before `correlation_id` existed. */
const GUARD_WITHOUT_CORRELATION = `create or replace function wager_transactions_guard_update() returns trigger language plpgsql as $$
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
   $$`;

/** The same guard with `correlation_id` among the identity columns. */
const GUARD_WITH_CORRELATION = `create or replace function wager_transactions_guard_update() returns trigger language plpgsql as $$
   begin
     if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
       raise exception 'wager transaction % is % and cannot change', old.id, old.status;
     end if;
     if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
         new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind,
         new.amount, new.currency, new.reference_external_transaction_id, new.created_at,
         new.correlation_id)
        is distinct from
        (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
         old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind,
         old.amount, old.currency, old.reference_external_transaction_id, old.created_at,
         old.correlation_id) then
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
   $$`;

/**
 * S7 review, m1: the correlation id the worker's events carry (L-15) is part of a transaction's
 * identity, so the update guard refuses to change it, and it is never empty. `down` restores the
 * guard of the initial schema.
 */
export class Migration20261113040000_correlation_id_guard extends Migration {
  override up(): void {
    this.addSql(
      `alter table wager_transactions
         add constraint wager_transactions_correlation_id_not_empty check (correlation_id <> '')`,
    );
    this.addSql(GUARD_WITH_CORRELATION);
  }

  override down(): void {
    this.addSql(GUARD_WITHOUT_CORRELATION);
    this.addSql(
      'alter table wager_transactions drop constraint wager_transactions_correlation_id_not_empty',
    );
  }
}
