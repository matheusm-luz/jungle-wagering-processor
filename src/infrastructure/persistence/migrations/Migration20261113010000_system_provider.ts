import { Migration } from '@mikro-orm/migrations';

/**
 * The provider id `SYSTEM` belongs to the internal `OPENING` transaction, and only to it (S3
 * review, M1). Without this, any caller could submit `providerId: "SYSTEM"` and share the
 * namespace of the opening rows: its external ids (`opening:<walletId>`) are predictable, so a
 * reversal could name an opening as its reference. Validated against existing rows when added.
 */
export class Migration20261113010000_system_provider extends Migration {
  override up(): void {
    this.addSql(
      `alter table wager_transactions
         add constraint wager_transactions_system_provider_only_for_opening
         check ((provider_id = 'SYSTEM') = (kind = 'OPENING'))`,
    );
  }

  override down(): void {
    this.addSql(
      'alter table wager_transactions drop constraint wager_transactions_system_provider_only_for_opening',
    );
  }
}
