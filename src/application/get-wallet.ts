import type { Wallet } from '../domain/wallet';
import { WalletNotFoundError } from './errors';
import type { WalletQueries } from './ports';

/** `GET /wallets/:walletId`: the last committed state, read without a lock. */
export class GetWallet {
  constructor(private readonly wallets: WalletQueries) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError();
    }
    return wallet;
  }
}
