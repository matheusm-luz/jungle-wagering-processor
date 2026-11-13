import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletNotFoundError } from './errors';
import type { WalletQueries } from './ports';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  hasMore: boolean;
}

/**
 * `GET /wallets/:walletId/ledger` (R-45): keyset pagination on the wallet's `sequence`. A sequence
 * is written once and never changes, so a page boundary is stable under concurrent writes; new
 * entries only ever append after it. Sequences need not start at 1 (a zero opening starts at 2).
 */
export class GetLedger {
  constructor(private readonly wallets: WalletQueries) {}

  async execute(walletId: string, afterSequence: number, limit: number): Promise<LedgerPage> {
    // One extra row says whether another page exists without a count.
    const entries = await this.wallets.ledgerPage(walletId, afterSequence, limit + 1);
    if (entries === undefined) {
      throw new WalletNotFoundError();
    }
    return { entries: entries.slice(0, limit), hasMore: entries.length > limit };
  }
}
