import { Migration } from '@mikro-orm/migrations';

const CODES = `'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'CURRENCY_MISMATCH',
  'WALLET_PLAYER_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH',
  'REFERENCE_KIND_NOT_ALLOWED', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_AMOUNT_MISMATCH',
  'REFERENCE_ALREADY_REVERSED', 'PROCESSING_FAILED'`;

/**
 * `BALANCE_LIMIT_EXCEEDED`: a credit that would take the balance beyond `NUMERIC(19,2)` is a
 * persisted rejection (docs/tasks/S4.md, Q1). `down` refuses to run while a row uses the code.
 */
export class Migration20261113020000_balance_limit extends Migration {
  override up(): void {
    this.replaceCheck(`${CODES}, 'BALANCE_LIMIT_EXCEEDED'`);
  }

  override down(): void {
    this.replaceCheck(CODES);
  }

  private replaceCheck(codes: string): void {
    this.addSql(
      `alter table wager_transactions
         drop constraint wager_transactions_failure_code_valid,
         add constraint wager_transactions_failure_code_valid check (failure_code in (${codes}))`,
    );
  }
}
