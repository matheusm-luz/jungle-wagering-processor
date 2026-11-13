import type { MoneyProps } from '../domain/money';
import { WalletNotFoundError } from './errors';
import type { ReconciliationInput, WalletQueries } from './ports';

/** Statement §9, `POST /wallets/:walletId/reconciliation`. */
export interface Reconciliation {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * The balance rebuilt from the ledger is credits minus debits. The difference comes from
 * `subtract`, never `Money.from`: it is negative when the stored balance is below the ledger.
 */
export function reconcile(input: ReconciliationInput): Reconciliation {
  const calculated = input.credits.subtract(input.debits);
  const difference = input.stored.subtract(calculated);
  return {
    walletId: input.walletId,
    storedBalance: input.stored.toJSON(),
    calculatedBalance: calculated.toJSON(),
    difference: difference.toJSON(),
    consistent: difference.isZero(),
    checkedEntries: input.entries,
  };
}

/** Reports a divergence and never fixes it (R-49): the caller logs and counts it. */
export class ReconcileWallet {
  constructor(private readonly wallets: WalletQueries) {}

  async execute(walletId: string): Promise<Reconciliation> {
    const input = await this.wallets.reconciliationInput(walletId);
    if (input === undefined) {
      throw new WalletNotFoundError();
    }
    return reconcile(input);
  }
}
