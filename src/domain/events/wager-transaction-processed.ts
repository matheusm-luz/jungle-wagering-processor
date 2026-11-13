import { InvalidIntegrationEventError } from '../errors';
import type { MoneyProps } from '../money';
import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction';
import type { Wallet } from '../wallet';
import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
} from './integration-event';

/** Not defined by the statement; chosen on 13 Nov (docs/tasks/S3.md, Q3). */
export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  /** The wallet balance once the transaction was applied (its observed balance). */
  balance: MoneyProps;
  walletVersion: number;
}

/** Emitted for every applied transaction, `LOSS` included (statement §11). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
    this.seal();
  }

  /** `wallet` is the transaction's wallet after the transaction was applied. */
  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    const { observedBalance, referenceExternalTransactionId: reference } = transaction;
    if (transaction.status !== WagerTransactionStatus.Processed || observedBalance === undefined) {
      throw new InvalidIntegrationEventError(
        'WagerTransactionProcessed needs a PROCESSED transaction',
      );
    }
    if (transaction.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError('The wallet is not the wallet of the transaction');
    }

    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
        balance: observedBalance.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
