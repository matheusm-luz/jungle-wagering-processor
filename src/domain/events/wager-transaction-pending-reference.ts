import { InvalidIntegrationEventError } from '../errors';
import { type WagerTransaction, WagerTransactionStatus } from '../wager-transaction';
import type { Wallet } from '../wallet';
import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
} from './integration-event';
import {
  transactionEventData,
  type WagerTransactionProcessedData,
} from './wager-transaction-processed';

/**
 * Emitted once, when a transaction starts to wait for its reference (statement §11). Its data is
 * that of `WagerTransactionProcessed` (docs/tasks/S7.md, Q3); the balance did not move.
 */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
    this.seal();
  }

  /** `wallet` is the transaction's wallet, unchanged by the wait. */
  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    const { observedBalance } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      observedBalance === undefined
    ) {
      throw new InvalidIntegrationEventError(
        'WagerTransactionPendingReference needs a PENDING_REFERENCE transaction',
      );
    }

    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: wallet.id,
      data: transactionEventData(transaction, observedBalance, wallet),
    });
  }
}
