import { InvalidIntegrationEventError } from '../errors';
import type { FailureCode } from '../failure-code';
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

/** The data of `WagerTransactionProcessed` plus the code (docs/tasks/S4.md, Q2). */
export interface WagerTransactionRejectedData extends WagerTransactionProcessedData {
  failureCode: FailureCode;
}

/**
 * Emitted for every business rejection (statement §11), and for a `FAILED` transaction, whose
 * `failureCode` is `PROCESSING_FAILED` (docs/tasks/S12.md, Q2). The balance did not move.
 */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
    this.seal();
  }

  /** `wallet` is the transaction's wallet, unchanged by the rejection. */
  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionRejected {
    const { observedBalance, failureCode } = transaction;
    if (
      (transaction.status !== WagerTransactionStatus.Rejected &&
        transaction.status !== WagerTransactionStatus.Failed) ||
      observedBalance === undefined ||
      failureCode === undefined
    ) {
      throw new InvalidIntegrationEventError(
        'WagerTransactionRejected needs a REJECTED or FAILED transaction',
      );
    }

    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: wallet.id,
      data: { ...transactionEventData(transaction, observedBalance, wallet), failureCode },
    });
  }
}
