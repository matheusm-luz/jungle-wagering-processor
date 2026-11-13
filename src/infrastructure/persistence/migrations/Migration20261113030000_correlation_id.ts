import { Migration } from '@mikro-orm/migrations';

/**
 * L-15 (docs/tasks/S7.md, Q1): the correlation id of the request that created a transaction, so
 * the events the pending-reference worker emits later keep it. Nullable: rows written before this
 * migration have none, and the worker generates one for them.
 */
export class Migration20261113030000_correlation_id extends Migration {
  override up(): void {
    this.addSql('alter table wager_transactions add column correlation_id text');
  }

  override down(): void {
    this.addSql('alter table wager_transactions drop column correlation_id');
  }
}
