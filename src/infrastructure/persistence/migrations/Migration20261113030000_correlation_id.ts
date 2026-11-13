import { Migration } from '@mikro-orm/migrations';

/**
 * L-15 (docs/tasks/S7.md, Q1): the correlation id of the request that created a transaction, so
 * the events the pending-reference worker emits later keep it. Nullable: rows written before this
 * migration have none, and the worker generates one for them. Never empty, and never changed once
 * written (S7 review, m1): a narrow trigger on the shared `forbid_change()` refuses a change.
 */
export class Migration20261113030000_correlation_id extends Migration {
  override up(): void {
    this.addSql(
      `alter table wager_transactions
         add column correlation_id text
           constraint wager_transactions_correlation_id_not_empty check (correlation_id <> '')`,
    );
    this.addSql(
      `create trigger wager_transactions_forbid_correlation_change
         before update of correlation_id on wager_transactions
         for each row when (old.correlation_id is distinct from new.correlation_id)
         execute function forbid_change()`,
    );
  }

  override down(): void {
    this.addSql('drop trigger wager_transactions_forbid_correlation_change on wager_transactions');
    this.addSql('alter table wager_transactions drop column correlation_id');
  }
}
