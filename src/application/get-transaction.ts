import type { WagerTransaction } from '../domain/wager-transaction';
import { TransactionNotFoundError } from './errors';
import type { WalletQueries } from './ports';

/** Statement §9: a transaction by its id or by provider + external id, read without a lock. */
export class GetTransaction {
  constructor(private readonly wallets: WalletQueries) {}

  async byId(id: string): Promise<WagerTransaction> {
    return found(await this.wallets.findTransactionById(id));
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return found(await this.wallets.findTransactionByExternalId(providerId, externalTransactionId));
  }
}

function found(transaction: WagerTransaction | undefined): WagerTransaction {
  if (transaction === undefined) {
    throw new TransactionNotFoundError();
  }
  return transaction;
}
